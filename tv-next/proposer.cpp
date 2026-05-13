#include "tv-next/proposer.h"

#include "tv-next/back.h"
#include "tv-next/range.h"

#include "llvm/IR/Argument.h"
#include "llvm/IR/BasicBlock.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/Instruction.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Intrinsics.h"
#include "llvm/IR/PatternMatch.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/Cloning.h"
#include "llvm/Transforms/Utils/ValueMapper.h"

#include <algorithm>
#include <map>
#include <set>
#include <vector>

namespace alive_tv_next {

namespace {

// ============================================================
// Utility helpers shared by multiple patterns
// ============================================================

llvm::Argument *findArgByName(llvm::Function *fn, const std::string &name) {
  for (llvm::Argument &arg : fn->args())
    if (arg.getName().str() == name)
      return &arg;
  return nullptr;
}

// Find a named Value (instruction or argument) anywhere in fn.
llvm::Value *findValueByName(const std::string &name, llvm::Function &fn) {
  for (llvm::BasicBlock &bb : fn)
    for (llvm::Instruction &I : bb)
      if (I.hasName() && I.getName().str() == name)
        return &I;
  for (llvm::Argument &arg : fn.args())
    if (arg.hasName() && arg.getName().str() == name)
      return &arg;
  return nullptr;
}

// ============================================================
// Flag-obligation synthesis: turn range facts about operands into Z3-friendly
// no-violation predicates for tgt-side flags.
// ============================================================
//
// Each LLVM poison-on-violation flag (nsw/nuw/exact/nneg/...) is equivalent
// to an explicit boolean predicate. When range analysis proves the violation
// predicate is unsatisfiable for given operand ranges, we synthesize the
// explicit predicate as an assume — Z3 discharges that against the flagged
// instruction structurally instead of doing nonlinear bit-vector reasoning.
//
// Currently handled flags (everything range analysis alone can prove):
//   add/sub/mul + nsw/nuw    -> {s,u}{add,sub,mul}.with.overflow
//   shl        + nsw/nuw    -> (a shl s) {ashr,lshr} s == a
//   zext       + nneg       -> icmp sge a, 0
// Flags requiring known-bits (`exact`, `disjoint`) or alloc-extent
// (`inbounds`) are not synthesized — fit tests would always fail without
// the extra analysis. They slot into the same dispatch when those analyses
// land.

enum class FlagKind {
  AddNSW,
  AddNUW,
  SubNSW,
  SubNUW,
  MulNSW,
  MulNUW,
  ShlNSW,
  ShlNUW,
  ZExtNNeg,
  UDivExact,
  SDivExact,
  LShrExact,
  AShrExact,
  OrDisjoint
};

// Look up a value's known range — from `facts` if available, otherwise the
// natural range of its type (the same seed we feed the analyzer). Constants
// collapse to a singleton range. For non-integer values returns an empty
// KnownRange.
template <typename FactsT>
KnownRange rangeForOperand(llvm::Value *V, const FactsT &facts) {
  KnownRange r;
  if (auto *C = llvm::dyn_cast<llvm::ConstantInt>(V)) {
    const llvm::APInt &val = C->getValue();
    r.u = {val, val};
    r.s = {val, val};
    r.bits = llvm::KnownBits::makeConstant(val);
    r.undef_free = true;
    r.poison_free = true;
    return r;
  }
  if (V->hasName()) {
    std::string name = V->getName().str();
    for (auto &f : facts) {
      if (f.name == name) {
        r.u = f.u_bound;
        r.s = f.s_bound;
        r.bits = f.bits;
        r.poison_free = f.poison_free;
        return r;
      }
    }
  }
  if (auto *ity = llvm::dyn_cast<llvm::IntegerType>(V->getType())) {
    unsigned bw = ity->getBitWidth();
    r.u = {llvm::APInt::getZero(bw), llvm::APInt::getAllOnes(bw)};
    r.s = {llvm::APInt::getSignedMinValue(bw),
           llvm::APInt::getSignedMaxValue(bw)};
  }
  return r;
}

// Helper: combine two interval corners under a binary op, in wide arithmetic.
// Returns {min, max} across all four pairwise combinations.
template <typename Op>
std::pair<llvm::APInt, llvm::APInt>
combineCorners(const llvm::APInt &a_lo, const llvm::APInt &a_hi,
               const llvm::APInt &b_lo, const llvm::APInt &b_hi, Op op) {
  llvm::APInt c1 = op(a_lo, b_lo);
  llvm::APInt c2 = op(a_lo, b_hi);
  llvm::APInt c3 = op(a_hi, b_lo);
  llvm::APInt c4 = op(a_hi, b_hi);
  llvm::APInt mn = llvm::APIntOps::smin(llvm::APIntOps::smin(c1, c2),
                                        llvm::APIntOps::smin(c3, c4));
  llvm::APInt mx = llvm::APIntOps::smax(llvm::APIntOps::smax(c1, c2),
                                        llvm::APIntOps::smax(c3, c4));
  return {mn, mx};
}

// Fit tests. Each returns true iff range analysis proves the corresponding
// flag's violation cannot occur. result_bw is the bit-width of the
// instruction's result type.

bool fitsSignedRange(const llvm::APInt &mn, const llvm::APInt &mx,
                     unsigned result_bw) {
  unsigned w = mn.getBitWidth();
  llvm::APInt lo = llvm::APInt::getSignedMinValue(result_bw).sext(w);
  llvm::APInt hi = llvm::APInt::getSignedMaxValue(result_bw).sext(w);
  return mn.sge(lo) && mx.sle(hi);
}

bool fitsUnsignedRange(const llvm::APInt &mn, const llvm::APInt &mx,
                       unsigned result_bw) {
  unsigned w = mn.getBitWidth();
  llvm::APInt lo = llvm::APInt::getZero(result_bw).zext(w);
  llvm::APInt hi = llvm::APInt::getAllOnes(result_bw).zext(w);
  return mn.sge(lo) && mx.sle(hi);
}

bool canProveSafe(FlagKind kind, const KnownRange &a, const KnownRange &b,
                  unsigned result_bw) {
  auto sext_pair = [](const std::pair<llvm::APInt, llvm::APInt> &p,
                      unsigned w) {
    return std::make_pair(p.first.sext(w), p.second.sext(w));
  };
  auto zext_pair = [](const std::pair<llvm::APInt, llvm::APInt> &p,
                      unsigned w) {
    return std::make_pair(p.first.zext(w), p.second.zext(w));
  };

  switch (kind) {
  case FlagKind::AddNSW:
  case FlagKind::SubNSW:
  case FlagKind::MulNSW: {
    if (!a.s || !b.s)
      return false;
    unsigned w = std::max(result_bw, 2 * result_bw + 4);
    auto [al, ah] = sext_pair(*a.s, w);
    auto [bl, bh] = sext_pair(*b.s, w);
    std::pair<llvm::APInt, llvm::APInt> mm;
    if (kind == FlagKind::AddNSW)
      mm = combineCorners(
          al, ah, bl, bh,
          [](const llvm::APInt &x, const llvm::APInt &y) { return x + y; });
    else if (kind == FlagKind::SubNSW)
      mm = combineCorners(
          al, ah, bl, bh,
          [](const llvm::APInt &x, const llvm::APInt &y) { return x - y; });
    else
      mm = combineCorners(
          al, ah, bl, bh,
          [](const llvm::APInt &x, const llvm::APInt &y) { return x * y; });
    return fitsSignedRange(mm.first, mm.second, result_bw);
  }
  case FlagKind::AddNUW:
  case FlagKind::SubNUW:
  case FlagKind::MulNUW: {
    if (!a.u || !b.u)
      return false;
    unsigned w = std::max(result_bw, 2 * result_bw + 4);
    auto [al, ah] = zext_pair(*a.u, w);
    auto [bl, bh] = zext_pair(*b.u, w);
    std::pair<llvm::APInt, llvm::APInt> mm;
    if (kind == FlagKind::AddNUW)
      mm = {al + bl, ah + bh};
    else if (kind == FlagKind::SubNUW) {
      // a - b can underflow if a < b. Safe iff a.lo >= b.hi.
      if (a.u->first.zext(w).ult(b.u->second.zext(w)))
        return false;
      mm = {al - bh, ah - bl};
    } else
      mm = {al * bl, ah * bh};
    return fitsUnsignedRange(mm.first, mm.second, result_bw);
  }
  case FlagKind::ShlNSW: {
    // a shl s does not signed-overflow iff a in [-2^(W-1-s.hi),
    // 2^(W-1-s.hi)-1].
    if (!a.s || !b.u)
      return false;
    const llvm::APInt &shi = b.u->second;
    if (shi.uge(result_bw))
      return false;
    unsigned remaining = result_bw - 1 - shi.getZExtValue();
    unsigned w = result_bw + 2;
    llvm::APInt a_lo = a.s->first.sext(w), a_hi = a.s->second.sext(w);
    llvm::APInt hi = llvm::APInt::getOneBitSet(w, remaining) - 1;
    llvm::APInt lo = -hi - 1;
    return a_lo.sge(lo) && a_hi.sle(hi);
  }
  case FlagKind::ShlNUW: {
    // a shl s does not unsigned-overflow iff a.u.hi < 2^(W - s.hi).
    if (!a.u || !b.u)
      return false;
    const llvm::APInt &shi = b.u->second;
    if (shi.uge(result_bw))
      return false;
    unsigned remaining = result_bw - shi.getZExtValue();
    unsigned w = result_bw + 2;
    llvm::APInt a_hi = a.u->second.zext(w);
    llvm::APInt cap = llvm::APInt::getOneBitSet(w, remaining);
    return a_hi.ult(cap);
  }
  case FlagKind::ZExtNNeg: {
    if (!a.s)
      return false;
    return a.s->first.isNonNegative();
  }
  case FlagKind::OrDisjoint: {
    // No bit position can be 1 in both operands.
    if (!a.bits || !b.bits)
      return false;
    return llvm::KnownBits::haveNoCommonBitsSet(*a.bits, *b.bits);
  }
  case FlagKind::LShrExact:
  case FlagKind::AShrExact: {
    // No low bits get shifted out: a's low `shift_amount` bits are zero.
    // We need an upper bound on the shift amount and matching known-zero
    // low bits in a.
    if (!a.bits || !b.u)
      return false;
    unsigned hi = (unsigned)b.u->second.getLimitedValue(result_bw);
    if (hi == 0)
      return true; // shift by 0 is always exact
    if (hi >= result_bw)
      return false;
    return a.bits->Zero.countr_one() >= hi;
  }
  case FlagKind::UDivExact:
  case FlagKind::SDivExact: {
    // a is divisible by b. We handle the common case: b is a constant power
    // of two (positive or negative for sdiv), and a's low log2(|b|) bits
    // are known zero.
    if (!a.bits || !b.bits)
      return false;
    if (!b.bits->isConstant())
      return false;
    llvm::APInt c = b.bits->getConstant();
    if (c.isZero())
      return false;
    llvm::APInt abs_c = (kind == FlagKind::SDivExact && c.isNegative())
                            ? llvm::APInt(c.getBitWidth(), 0) - c
                            : c;
    if (!abs_c.isPowerOf2())
      return false;
    unsigned k = abs_c.logBase2();
    return a.bits->Zero.countr_one() >= k;
  }
  }
  return false;
}

// Map (opcode, flag-kind) to the no-violation predicate IR. `operands` is
// in the source-order of the matched instruction.
llvm::Value *buildFlagClaim(llvm::IRBuilder<> &bld, llvm::Module *M,
                            FlagKind kind,
                            const std::vector<llvm::Value *> &operands,
                            unsigned result_bw) {
  llvm::LLVMContext &ctx = bld.getContext();
  auto buildOvfClaim = [&](llvm::Intrinsic::ID id) -> llvm::Value * {
    llvm::Function *intrin = llvm::Intrinsic::getOrInsertDeclaration(
        M, id, {operands[0]->getType()});
    llvm::CallInst *call = bld.CreateCall(intrin, {operands[0], operands[1]});
    llvm::Value *ovf = bld.CreateExtractValue(call, {1});
    return bld.CreateXor(ovf, llvm::ConstantInt::getTrue(ctx));
  };

  switch (kind) {
  case FlagKind::AddNSW:
    return buildOvfClaim(llvm::Intrinsic::sadd_with_overflow);
  case FlagKind::AddNUW:
    return buildOvfClaim(llvm::Intrinsic::uadd_with_overflow);
  case FlagKind::SubNSW:
    return buildOvfClaim(llvm::Intrinsic::ssub_with_overflow);
  case FlagKind::SubNUW:
    return buildOvfClaim(llvm::Intrinsic::usub_with_overflow);
  case FlagKind::MulNSW:
    return buildOvfClaim(llvm::Intrinsic::smul_with_overflow);
  case FlagKind::MulNUW:
    return buildOvfClaim(llvm::Intrinsic::umul_with_overflow);
  case FlagKind::ShlNSW: {
    llvm::Value *v = bld.CreateShl(operands[0], operands[1]);
    v = bld.CreateAShr(v, operands[1]);
    return bld.CreateICmpEQ(v, operands[0]);
  }
  case FlagKind::ShlNUW: {
    llvm::Value *v = bld.CreateShl(operands[0], operands[1]);
    v = bld.CreateLShr(v, operands[1]);
    return bld.CreateICmpEQ(v, operands[0]);
  }
  case FlagKind::ZExtNNeg: {
    llvm::Type *ty = operands[0]->getType();
    return bld.CreateICmpSGE(operands[0], llvm::ConstantInt::get(ty, 0));
  }
  case FlagKind::OrDisjoint: {
    // `a & b == 0` — no bit set in both.
    llvm::Value *anded = bld.CreateAnd(operands[0], operands[1]);
    return bld.CreateICmpEQ(anded,
                            llvm::ConstantInt::get(operands[0]->getType(), 0));
  }
  case FlagKind::LShrExact: {
    // `(a lshr s) shl s == a` — no low bits lost.
    llvm::Value *v = bld.CreateLShr(operands[0], operands[1]);
    v = bld.CreateShl(v, operands[1]);
    return bld.CreateICmpEQ(v, operands[0]);
  }
  case FlagKind::AShrExact: {
    // `(a ashr s) shl s == a` — same shape; ashr preserves sign so the
    // round-trip equality only holds when the low bits were zero.
    llvm::Value *v = bld.CreateAShr(operands[0], operands[1]);
    v = bld.CreateShl(v, operands[1]);
    return bld.CreateICmpEQ(v, operands[0]);
  }
  case FlagKind::UDivExact: {
    // `(a udiv b) * b == a`.
    llvm::Value *q = bld.CreateUDiv(operands[0], operands[1]);
    llvm::Value *mul = bld.CreateMul(q, operands[1]);
    return bld.CreateICmpEQ(mul, operands[0]);
  }
  case FlagKind::SDivExact: {
    // `(a sdiv b) * b == a`. Same round-trip; signed div makes the multiply
    // recover a exactly iff remainder was zero.
    llvm::Value *q = bld.CreateSDiv(operands[0], operands[1]);
    llvm::Value *mul = bld.CreateMul(q, operands[1]);
    return bld.CreateICmpEQ(mul, operands[0]);
  }
  }
  (void)result_bw;
  return nullptr;
}

// Match an instruction in `fn` whose opcode, result type, and operand-name
// multiset (for commutative ops) or ordered-name list (otherwise) match `T`.
// Operand "names" use SSA name when available (function args carry the
// parent value's name); ConstantInt operands match by exact value.
struct OperandKey {
  std::string name; // empty for constants
  llvm::APInt const_val;
  bool is_const = false;
};

OperandKey keyForOperand(llvm::Value *V) {
  OperandKey k;
  if (auto *C = llvm::dyn_cast<llvm::ConstantInt>(V)) {
    k.is_const = true;
    k.const_val = C->getValue();
  } else if (V->hasName()) {
    k.name = V->getName().str();
  }
  return k;
}

bool operandKeysEqual(const OperandKey &a, const OperandKey &b) {
  if (a.is_const != b.is_const)
    return false;
  if (a.is_const)
    return a.const_val == b.const_val;
  return !a.name.empty() && a.name == b.name;
}

llvm::Instruction *findStructuralMatch(llvm::Instruction *T,
                                       llvm::Function *fn) {
  bool commutative = T->isCommutative();
  std::vector<OperandKey> tkeys;
  for (auto &U : T->operands())
    tkeys.push_back(keyForOperand(U.get()));

  for (auto &bb : *fn) {
    for (auto &I : bb) {
      if (I.getOpcode() != T->getOpcode())
        continue;
      if (I.getType() != T->getType())
        continue;
      if (I.getNumOperands() != T->getNumOperands())
        continue;
      std::vector<OperandKey> ikeys;
      for (auto &U : I.operands())
        ikeys.push_back(keyForOperand(U.get()));
      bool match;
      if (commutative && ikeys.size() == 2) {
        match = (operandKeysEqual(tkeys[0], ikeys[0]) &&
                 operandKeysEqual(tkeys[1], ikeys[1])) ||
                (operandKeysEqual(tkeys[0], ikeys[1]) &&
                 operandKeysEqual(tkeys[1], ikeys[0]));
      } else {
        match = true;
        for (size_t i = 0; match && i < tkeys.size(); ++i)
          match = operandKeysEqual(tkeys[i], ikeys[i]);
      }
      if (match)
        return &I;
    }
  }
  return nullptr;
}

// A proof obligation we can discharge: tgt has a flag whose violation is
// provably impossible given range facts on the operands.
struct FlagObligation {
  llvm::Instruction *tgt_inst; // for diagnostics; we resolve operands by key
  FlagKind kind;
  // Operand "keys" — names of unit args or constant integer values, in src
  // order. We use keys (not Value*) so the same obligation can be resolved
  // both in the cloned-unit (for injection) and in the rebuilt-slice (for
  // the standalone assume-check).
  std::vector<OperandKey> op_keys;
};

// Enumerate the flag-kinds added in tgt vs src (i.e. set in T but not in S),
// for kinds canProveSafe handles.
void collectAddedFlags(llvm::Instruction *T, llvm::Instruction *S,
                       std::vector<FlagKind> &out) {
  auto *Tobo = llvm::dyn_cast<llvm::OverflowingBinaryOperator>(T);
  auto *Sobo = llvm::dyn_cast<llvm::OverflowingBinaryOperator>(S);
  if (Tobo && Sobo) {
    bool nsw = Tobo->hasNoSignedWrap() && !Sobo->hasNoSignedWrap();
    bool nuw = Tobo->hasNoUnsignedWrap() && !Sobo->hasNoUnsignedWrap();
    if (nsw || nuw) {
      switch (T->getOpcode()) {
      case llvm::Instruction::Add:
        if (nsw)
          out.push_back(FlagKind::AddNSW);
        if (nuw)
          out.push_back(FlagKind::AddNUW);
        break;
      case llvm::Instruction::Sub:
        if (nsw)
          out.push_back(FlagKind::SubNSW);
        if (nuw)
          out.push_back(FlagKind::SubNUW);
        break;
      case llvm::Instruction::Mul:
        if (nsw)
          out.push_back(FlagKind::MulNSW);
        if (nuw)
          out.push_back(FlagKind::MulNUW);
        break;
      case llvm::Instruction::Shl:
        if (nsw)
          out.push_back(FlagKind::ShlNSW);
        if (nuw)
          out.push_back(FlagKind::ShlNUW);
        break;
      default:
        break;
      }
    }
  }
  if (auto *Tzext = llvm::dyn_cast<llvm::ZExtInst>(T)) {
    auto *Szext = llvm::dyn_cast<llvm::ZExtInst>(S);
    if (Szext && Tzext->hasNonNeg() && !Szext->hasNonNeg())
      out.push_back(FlagKind::ZExtNNeg);
  }
  // `exact` on udiv/sdiv/lshr/ashr — PossiblyExactOperator covers all four.
  if (auto *Texact = llvm::dyn_cast<llvm::PossiblyExactOperator>(T)) {
    auto *Sexact = llvm::dyn_cast<llvm::PossiblyExactOperator>(S);
    if (Sexact && Texact->isExact() && !Sexact->isExact()) {
      switch (T->getOpcode()) {
      case llvm::Instruction::UDiv:
        out.push_back(FlagKind::UDivExact);
        break;
      case llvm::Instruction::SDiv:
        out.push_back(FlagKind::SDivExact);
        break;
      case llvm::Instruction::LShr:
        out.push_back(FlagKind::LShrExact);
        break;
      case llvm::Instruction::AShr:
        out.push_back(FlagKind::AShrExact);
        break;
      default:
        break;
      }
    }
  }
  // `disjoint` on or — PossiblyDisjointInst.
  if (auto *Tdis = llvm::dyn_cast<llvm::PossiblyDisjointInst>(T)) {
    auto *Sdis = llvm::dyn_cast<llvm::PossiblyDisjointInst>(S);
    if (Sdis && Tdis->isDisjoint() && !Sdis->isDisjoint())
      out.push_back(FlagKind::OrDisjoint);
  }
}

// ============================================================
// proposeFromRanges helpers: generic range-fact assume injection
// ============================================================

// A single named value (an input to the unit, derived in parent_src) with the
// range-analysis facts we want to inject as assumes. All fields are optional;
// at least one must carry real information for the fact to be useful.
struct KnownFact {
  std::string name;    // SSA name in both unit.src_fn (as arg) and parent_src
  BackwardSlice slice; // backward slice in parent_src needed to recheck claims
  std::optional<std::pair<llvm::APInt, llvm::APInt>> u_bound; // closed [lo, hi]
  std::optional<std::pair<llvm::APInt, llvm::APInt>> s_bound; // closed [lo, hi]
  std::optional<llvm::KnownBits> bits;
  bool poison_free = false;

  bool empty() const {
    return !u_bound && !s_bound && !poison_free && (!bits || bits->isUnknown());
  }
};

// Build the conjunction of all claims about `value` as a single i1 Value.
// Returns nullptr if the fact carries no claims (empty fact).
llvm::Value *buildFactPredicate(llvm::IRBuilder<> &bld, llvm::Value *value,
                                const KnownFact &fact) {
  llvm::Type *ty = value->getType();
  llvm::Value *result = nullptr;
  auto andIn = [&](llvm::Value *p) {
    result = result ? bld.CreateAnd(result, p, fact.name + "_and") : p;
  };

  if (fact.u_bound) {
    const auto &[lo, hi] = *fact.u_bound;
    llvm::Value *p = bld.CreateICmpULE(value, llvm::ConstantInt::get(ty, hi),
                                       fact.name + "_uub");
    if (lo != llvm::APInt::getZero(lo.getBitWidth())) {
      llvm::Value *lp = bld.CreateICmpUGE(value, llvm::ConstantInt::get(ty, lo),
                                          fact.name + "_ulb");
      p = bld.CreateAnd(p, lp, fact.name + "_u");
    }
    andIn(p);
  }
  if (fact.s_bound) {
    const auto &[lo, hi] = *fact.s_bound;
    llvm::Value *p = bld.CreateICmpSLE(value, llvm::ConstantInt::get(ty, hi),
                                       fact.name + "_sub");
    llvm::Value *lp = bld.CreateICmpSGE(value, llvm::ConstantInt::get(ty, lo),
                                        fact.name + "_slb");
    p = bld.CreateAnd(p, lp, fact.name + "_s");
    andIn(p);
  }
  if (fact.poison_free) {
    // freeze(v) == v iff v is non-poison and non-undef. icmp on poison is
    // itself poison, so assume() on this fact is what prunes poison inputs.
    llvm::Value *frozen = bld.CreateFreeze(value, fact.name + "_fz");
    llvm::Value *p = bld.CreateICmpEQ(value, frozen, fact.name + "_pf");
    andIn(p);
  }
  if (fact.bits && !fact.bits->isUnknown()) {
    // (v & mask) == known_ones, where mask covers every bit position we
    // have *any* information about. Captures alignment, non-zero, specific
    // bits set/clear, etc. in one predicate.
    llvm::APInt mask = fact.bits->Zero | fact.bits->One;
    llvm::Value *masked = bld.CreateAnd(value, llvm::ConstantInt::get(ty, mask),
                                        fact.name + "_bm");
    llvm::Value *p = bld.CreateICmpEQ(
        masked, llvm::ConstantInt::get(ty, fact.bits->One), fact.name + "_b");
    andIn(p);
  }
  return result;
}

// Inject `call void @llvm.assume(<all-claims-for-fact>)` at fn's entry, using
// the function argument that shares the fact's name. No-op if the fact is
// empty or the named arg doesn't exist.
void injectFactAssumes(llvm::Function *fn, const KnownFact &fact) {
  if (fact.empty())
    return;
  llvm::Argument *arg = findArgByName(fn, fact.name);
  if (!arg)
    return;
  llvm::BasicBlock &entry = fn->getEntryBlock();
  llvm::IRBuilder<> bld(&entry, entry.begin());
  llvm::Value *cond = buildFactPredicate(bld, arg, fact);
  if (!cond)
    return;
  llvm::Function *assume_fn = llvm::Intrinsic::getOrInsertDeclaration(
      fn->getParent(), llvm::Intrinsic::assume);
  bld.CreateCall(assume_fn, {cond});
}

// Resolve an OperandKey within a function: named keys → function arg with
// that name; constant keys → ConstantInt of the requested type. Returns null
// for missing named args (caller skips).
llvm::Value *resolveKeyInFn(llvm::Function *fn, const OperandKey &k,
                            llvm::Type *expected_ty) {
  if (k.is_const)
    return llvm::ConstantInt::get(expected_ty, k.const_val);
  return findArgByName(fn, k.name);
}

// Inject a single combined assume for an obligation in `fn`'s entry block:
// `call void @llvm.assume(claim)` where claim is the no-violation predicate.
void injectObligationAssume(llvm::Function *fn, const FlagObligation &ob,
                            const std::vector<llvm::Type *> &op_tys,
                            unsigned result_bw) {
  llvm::BasicBlock &entry = fn->getEntryBlock();
  llvm::IRBuilder<> bld(&entry, entry.begin());
  std::vector<llvm::Value *> operands;
  for (size_t i = 0; i < ob.op_keys.size(); ++i) {
    llvm::Value *v = resolveKeyInFn(fn, ob.op_keys[i], op_tys[i]);
    if (!v)
      return; // missing arg → skip this obligation in this fn
    operands.push_back(v);
  }
  llvm::Value *claim =
      buildFlagClaim(bld, fn->getParent(), ob.kind, operands, result_bw);
  if (!claim)
    return;
  llvm::Function *assume_fn = llvm::Intrinsic::getOrInsertDeclaration(
      fn->getParent(), llvm::Intrinsic::assume);
  bld.CreateCall(assume_fn, {claim});
}

// Build the standalone assume-check TvUnit for proposeFromRanges.
// @src: rebuilds the union of all per-fact slices in parent_src plus any
//       extra slices needed by obligation operands, and returns the
//       conjunction of all per-fact claims AND all per-obligation claims.
// @tgt: returns true unconditionally.
// If the check passes, every claim holds for every input to parent_src — so
// injecting the claims into the unit is sound (we only narrow the input
// space, never silently strengthen tgt).
TvUnit
buildCombinedFactCheck(const std::vector<KnownFact> &facts,
                       const std::vector<FlagObligation> &obligations,
                       const std::vector<std::vector<llvm::Type *>> &ob_op_tys,
                       const std::vector<unsigned> &ob_result_bws,
                       llvm::Function &parent_src, llvm::Module &parent_module,
                       llvm::LLVMContext &ctx, const std::string &diag_name) {
  TvUnit out;
  out.name = diag_name;
  out.module = std::make_unique<llvm::Module>("range_fact_check", ctx);
  out.module->setDataLayout(parent_module.getDataLayout());
  out.module->setTargetTriple(parent_module.getTargetTriple());

  llvm::Type *i1 = llvm::Type::getInt1Ty(ctx);

  // Union of arg_roots across all per-fact slices, sorted by argno.
  std::map<unsigned, llvm::Argument *> arg_map;
  for (auto &f : facts)
    for (auto *arg : f.slice.arg_roots)
      arg_map.emplace(arg->getArgNo(), arg);
  std::vector<llvm::Argument *> all_args;
  for (auto &[_, arg] : arg_map)
    all_args.push_back(arg);

  std::vector<llvm::Type *> params;
  for (auto *arg : all_args)
    params.push_back(arg->getType());

  llvm::FunctionType *fn_ty = llvm::FunctionType::get(i1, params, false);
  out.src_fn = llvm::Function::Create(fn_ty, llvm::Function::ExternalLinkage,
                                      "src", out.module.get());
  out.tgt_fn = llvm::Function::Create(fn_ty, llvm::Function::ExternalLinkage,
                                      "tgt", out.module.get());
  for (size_t i = 0; i < all_args.size(); ++i) {
    out.src_fn->getArg(i)->setName(all_args[i]->getName());
    out.tgt_fn->getArg(i)->setName(all_args[i]->getName());
  }

  // @src: rebuild the slice union, then AND all per-fact claims.
  {
    llvm::BasicBlock *bb = llvm::BasicBlock::Create(ctx, "entry", out.src_fn);
    llvm::IRBuilder<> bld(bb);

    std::map<llvm::Value *, llvm::Value *> vmap;
    for (size_t i = 0; i < all_args.size(); ++i)
      vmap[all_args[i]] = out.src_fn->getArg(i);

    std::set<llvm::Instruction *> inst_set;
    for (auto &f : facts)
      for (auto *I : f.slice.insts)
        inst_set.insert(I);

    for (llvm::BasicBlock &par_bb : parent_src) {
      for (llvm::Instruction &I : par_bb) {
        if (!inst_set.count(&I))
          continue;
        llvm::Instruction *cloned = I.clone();
        if (I.hasName())
          cloned->setName(I.getName());
        for (unsigned i = 0; i < cloned->getNumOperands(); ++i) {
          auto it = vmap.find(I.getOperand(i));
          if (it != vmap.end())
            cloned->setOperand(i, it->second);
        }
        bld.Insert(cloned);
        vmap[&I] = cloned;
      }
    }

    llvm::Value *result = nullptr;
    auto andIn = [&](llvm::Value *p) {
      if (!p)
        return;
      result = result ? bld.CreateAnd(result, p, "all") : p;
    };

    // Per-fact claims.
    for (auto &f : facts) {
      llvm::Value *parent_val = findValueByName(f.name, parent_src);
      if (!parent_val)
        continue;
      auto vit = vmap.find(parent_val);
      if (vit == vmap.end())
        continue;
      andIn(buildFactPredicate(bld, vit->second, f));
    }

    // Per-obligation claims: resolve each operand against the parent (named →
    // findValueByName → vmap; const → ConstantInt). Skip the obligation if
    // any non-const operand can't be resolved — the standalone soundness
    // gate would be incomplete otherwise.
    for (size_t k = 0; k < obligations.size(); ++k) {
      const FlagObligation &ob = obligations[k];
      std::vector<llvm::Value *> ops;
      bool ok = true;
      for (size_t i = 0; i < ob.op_keys.size(); ++i) {
        const OperandKey &key = ob.op_keys[i];
        if (key.is_const) {
          ops.push_back(llvm::ConstantInt::get(ob_op_tys[k][i], key.const_val));
          continue;
        }
        llvm::Value *parent_val = findValueByName(key.name, parent_src);
        if (!parent_val) {
          ok = false;
          break;
        }
        auto vit = vmap.find(parent_val);
        if (vit == vmap.end()) {
          ok = false;
          break;
        }
        ops.push_back(vit->second);
      }
      if (!ok)
        continue;
      andIn(buildFlagClaim(bld, out.module.get(), ob.kind, ops,
                           ob_result_bws[k]));
    }

    bld.CreateRet(result ? result : llvm::ConstantInt::getTrue(ctx));
  }

  // @tgt: trivially true.
  {
    llvm::BasicBlock *bb = llvm::BasicBlock::Create(ctx, "entry", out.tgt_fn);
    llvm::IRBuilder<> bld(bb);
    bld.CreateRet(llvm::ConstantInt::getTrue(ctx));
  }

  return out;
}

// ============================================================
// Registered hand-coded patterns
// ============================================================

// Hand-coded shape-specific proposers run before the generic
// `proposeFromRanges`. Append a lambda here to register one. Today this is
// empty — every previous pattern (mul→mul nsw via sext, freeze-drop on shl)
// is subsumed by the range-based proposer + flag-obligation synthesis.
const std::vector<AssumeProposerFn> kPatterns = {};

// ============================================================
// Range-based fallback proposer
// ============================================================

// Per-side fact/obligation bundle. proposeFromRanges runs collection on both
// parent_src and parent_tgt separately and discharges each side's claims
// against its own parent.
struct PerSideFacts {
  std::vector<KnownFact> facts;
  std::vector<FlagObligation> obligations;
  std::vector<std::vector<llvm::Type *>> ob_op_tys;
  std::vector<unsigned> ob_result_bws;

  bool empty() const {
    return facts.empty() && obligations.empty();
  }
};

// Collect facts and obligations whose bounds come from running range analysis
// on `parent_fn`. The obligation scan matches `unit.tgt_fn` against
// `unit.src_fn` structurally, but the fit-test consults this parent's range
// info on each operand.
//
// Seeding: each parent argument is seeded with its type's natural range plus
// well-defined flags (sound under --disable-undef-input — alive2 treats
// parent args as concrete integers in their type range, so the seed is a
// tautology the standalone assume-check trivially upholds).
PerSideFacts collectFromParent(const TvUnit &unit, llvm::Function &parent_fn) {
  PerSideFacts out;

  RangeMap seed;
  for (llvm::Argument &arg : parent_fn.args()) {
    if (!arg.getType()->isIntegerTy())
      continue;
    unsigned bw = arg.getType()->getIntegerBitWidth();
    KnownRange r;
    r.undef_free = true;
    r.poison_free = true;
    r.u = {llvm::APInt::getZero(bw), llvm::APInt::getAllOnes(bw)};
    r.s = {llvm::APInt::getSignedMinValue(bw),
           llvm::APInt::getSignedMaxValue(bw)};
    seed[&arg] = r;
  }
  std::vector<llvm::Instruction *> parent_insts;
  for (llvm::BasicBlock &bb : parent_fn)
    for (llvm::Instruction &I : bb)
      if (!I.isTerminator())
        parent_insts.push_back(&I);
  RangeMap ranges = computeRanges(parent_insts, seed);

  // Per-arg facts: for each named arg of unit.src_fn, harvest range info from
  // this parent's analysis.
  for (llvm::Argument &arg : unit.src_fn->args()) {
    if (!arg.hasName())
      continue;
    std::string name = arg.getName().str();
    llvm::Value *parent_val = findValueByName(name, parent_fn);
    if (!parent_val)
      continue;

    auto it = ranges.find(parent_val);
    if (it == ranges.end())
      continue;
    const KnownRange &r = it->second;

    KnownFact f;
    f.name = name;
    if (r.u && !r.u->second.isAllOnes())
      f.u_bound = *r.u;
    if (r.s &&
        (!r.s->first.isMinSignedValue() || !r.s->second.isMaxSignedValue()))
      f.s_bound = *r.s;
    if (r.bits && !r.bits->isUnknown())
      f.bits = *r.bits;
    if (r.poison_free)
      f.poison_free = true;
    if (f.empty())
      continue;

    auto slice = collectBackwardSlice(name, parent_fn);
    if (!slice)
      continue;
    bool has_phi = false;
    for (auto *I : slice->insts)
      if (llvm::isa<llvm::PHINode>(I)) {
        has_phi = true;
        break;
      }
    if (has_phi)
      continue;
    f.slice = std::move(*slice);
    out.facts.push_back(std::move(f));
  }

  // Obligation synthesis: scan unit.tgt_fn for added flags whose violation
  // predicate is unsatisfiable under this parent's operand ranges.
  auto factByName = [&](const std::string &n) -> const KnownFact * {
    for (auto &f : out.facts)
      if (f.name == n)
        return &f;
    return nullptr;
  };

  for (llvm::BasicBlock &bb : *unit.tgt_fn) {
    for (llvm::Instruction &T_inst : bb) {
      llvm::Instruction *T = &T_inst;
      llvm::Instruction *S = findStructuralMatch(T, unit.src_fn);
      if (!S)
        continue;
      std::vector<FlagKind> added;
      collectAddedFlags(T, S, added);
      if (added.empty())
        continue;

      std::vector<OperandKey> keys;
      std::vector<llvm::Type *> tys;
      bool ok = true;
      for (auto &U : T->operands()) {
        OperandKey k = keyForOperand(U.get());
        if (!k.is_const && (k.name.empty() || !factByName(k.name))) {
          ok = false;
          break;
        }
        keys.push_back(std::move(k));
        tys.push_back(U.get()->getType());
      }
      if (!ok)
        continue;

      unsigned result_bw =
          T->getType()->isIntegerTy() ? T->getType()->getIntegerBitWidth() : 0;
      if (result_bw == 0)
        continue;

      for (FlagKind fk : added) {
        KnownRange ra = rangeForOperand(T->getOperand(0), out.facts);
        KnownRange rb = (T->getNumOperands() >= 2)
                            ? rangeForOperand(T->getOperand(1), out.facts)
                            : KnownRange{};
        if (!canProveSafe(fk, ra, rb, result_bw))
          continue;
        out.obligations.push_back({T, fk, keys});
        out.ob_op_tys.push_back(tys);
        out.ob_result_bws.push_back(result_bw);
      }
    }
  }

  return out;
}

// Symmetric range-based proposer. Independent of cut shape (single-instr or
// multi-instr) and independent of what the diff is (added flag, freeze
// removal, instruction substitution, etc.).
//
// We collect facts/obligations against *both* parent_src and parent_tgt
// independently. Chain refinement (cuts 1..k-1 already verified) guarantees
// that well-defined values at cut k agree on both sides, so any bound
// derivable on either side is sound at the cut. The two sides often differ
// in precision — tgt-side analysis usually sees more optimization-injected
// info (added flags, simpler forms) and produces tighter ranges. Each side's
// claims are discharged against its own parent via a separate standalone
// assume-check; both must pass for the injection to be sound.
std::optional<AssumedTvUnit> proposeFromRanges(const TvUnit &unit,
                                               llvm::Function &parent_src,
                                               llvm::Function &parent_tgt,
                                               llvm::LLVMContext &ctx) {
  PerSideFacts src_side = collectFromParent(unit, parent_src);
  PerSideFacts tgt_side = collectFromParent(unit, parent_tgt);

  if (src_side.empty() && tgt_side.empty())
    return std::nullopt;

  // Build the modified unit: clone + inject every fact and obligation, from
  // both sides, on both modified.src_fn and modified.tgt_fn. The well-defined
  // input space is the same on both sides, so injecting both side's claims
  // is sound (each is independently discharged below).
  TvUnit modified;
  modified.name = unit.name + ".range-assume";
  {
    llvm::ValueToValueMapTy vmap;
    modified.module = llvm::CloneModule(*unit.module, vmap);
    modified.src_fn = modified.module->getFunction("src");
    modified.tgt_fn = modified.module->getFunction("tgt");
    auto injectFromSide = [&](const PerSideFacts &side) {
      for (auto &f : side.facts)
        for (llvm::Function *fn : {modified.src_fn, modified.tgt_fn})
          injectFactAssumes(fn, f);
      for (size_t k = 0; k < side.obligations.size(); ++k)
        for (llvm::Function *fn : {modified.src_fn, modified.tgt_fn})
          injectObligationAssume(fn, side.obligations[k], side.ob_op_tys[k],
                                 side.ob_result_bws[k]);
    };
    injectFromSide(src_side);
    injectFromSide(tgt_side);
  }

  AssumedTvUnit out;
  out.proposer_name = "FromRanges";
  out.modified_unit = std::move(modified);

  // One standalone check per side. Each check rebuilds slices in its own
  // parent and verifies the side's claims hold there. Together they ensure
  // every injected assume is justified.
  if (!src_side.empty())
    out.assume_checks.push_back(buildCombinedFactCheck(
        src_side.facts, src_side.obligations, src_side.ob_op_tys,
        src_side.ob_result_bws, parent_src, *parent_src.getParent(), ctx,
        unit.name + ".src-assume-check"));
  if (!tgt_side.empty())
    out.assume_checks.push_back(buildCombinedFactCheck(
        tgt_side.facts, tgt_side.obligations, tgt_side.ob_op_tys,
        tgt_side.ob_result_bws, parent_tgt, *parent_tgt.getParent(), ctx,
        unit.name + ".tgt-assume-check"));
  return out;
}

} // namespace

// ============================================================
// Public API
// ============================================================

std::optional<AssumedTvUnit> proposeAssume(const TvUnit &original_unit,
                                           llvm::Function &parent_src,
                                           llvm::Function &parent_tgt,
                                           llvm::LLVMContext &ctx) {
  for (const AssumeProposerFn &fn : kPatterns)
    if (auto r = fn(original_unit, parent_src, parent_tgt, ctx))
      return r;
  return proposeFromRanges(original_unit, parent_src, parent_tgt, ctx);
}

} // namespace alive_tv_next
