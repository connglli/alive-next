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

// Find the function's single non-terminator instruction (1-position cuts only).
// Returns nullptr if the cut has 0 or >1 such instructions.
llvm::Instruction *singleNonTerminator(llvm::Function &fn) {
  if (fn.size() != 1)
    return nullptr;
  llvm::Instruction *found = nullptr;
  for (llvm::Instruction &I : fn.front()) {
    if (I.isTerminator())
      continue;
    if (found)
      return nullptr;
    found = &I;
  }
  return found;
}

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
// Pattern 1 helpers: mul → mul nsw via sext/zext
// ============================================================

// Trace `name` in `parent_src` to a single sext/zext instruction to
// `expected_dst_ty`. Returns the extension's source description or nullopt.
struct ExtSource {
  std::string src_name;
  llvm::Type *src_ty = nullptr;
  bool is_signed = false;
};

std::optional<ExtSource> findExtSource(const std::string &name,
                                       llvm::Function &parent_src,
                                       llvm::Type *expected_dst_ty) {
  for (llvm::BasicBlock &bb : parent_src) {
    for (llvm::Instruction &I : bb) {
      if (!I.hasName() || I.getName().str() != name)
        continue;
      auto *cast = llvm::dyn_cast<llvm::CastInst>(&I);
      if (!cast)
        return std::nullopt;
      bool is_signed = llvm::isa<llvm::SExtInst>(cast);
      bool is_unsigned = llvm::isa<llvm::ZExtInst>(cast);
      if (!is_signed && !is_unsigned)
        return std::nullopt;
      if (cast->getDestTy() != expected_dst_ty)
        return std::nullopt;
      if (!cast->getSrcTy()->isIntegerTy())
        return std::nullopt;
      llvm::Value *src = cast->getOperand(0);
      if (!src->hasName())
        return std::nullopt;
      return ExtSource{src->getName().str(), cast->getSrcTy(), is_signed};
    }
  }
  return std::nullopt;
}

// Inject the no-overflow assume at the head of fn's entry block:
//   %ovf_pair = call {iN, i1} @llvm.smul.with.overflow.iN(a, b)
//   %ovf_bit  = extractvalue %ovf_pair, 1
//   %not_ovf  = xor i1 %ovf_bit, true
//   call void @llvm.assume(i1 %not_ovf)
void injectNoOverflowAssume(llvm::Function *fn, llvm::Argument *a,
                            llvm::Argument *b) {
  llvm::LLVMContext &ctx = fn->getContext();
  llvm::Module *M = fn->getParent();
  llvm::BasicBlock &entry = fn->getEntryBlock();
  llvm::IRBuilder<> bld(&entry, entry.begin());

  llvm::Type *mul_ty = a->getType();
  llvm::Function *smul_ovf = llvm::Intrinsic::getOrInsertDeclaration(
      M, llvm::Intrinsic::smul_with_overflow, {mul_ty});
  llvm::CallInst *call = bld.CreateCall(smul_ovf, {a, b}, "ovf_pair");
  llvm::Value *ovf_bit = bld.CreateExtractValue(call, {1}, "ovf_bit");
  llvm::Value *not_ovf =
      bld.CreateXor(ovf_bit, llvm::ConstantInt::getTrue(ctx), "not_ovf");
  llvm::Function *assume_fn =
      llvm::Intrinsic::getOrInsertDeclaration(M, llvm::Intrinsic::assume);
  bld.CreateCall(assume_fn, {not_ovf});
}

// Clone the TvUnit's module and inject no-overflow assumes on both sides.
TvUnit buildModifiedTvUnit(const TvUnit &original, const std::string &a_name,
                           const std::string &b_name,
                           const std::string &diag_name) {
  TvUnit out;
  out.name = diag_name;
  llvm::ValueToValueMapTy vmap;
  out.module = llvm::CloneModule(*original.module, vmap);
  out.src_fn = out.module->getFunction("src");
  out.tgt_fn = out.module->getFunction("tgt");
  for (llvm::Function *fn : {out.src_fn, out.tgt_fn}) {
    llvm::Argument *a = findArgByName(fn, a_name);
    llvm::Argument *b = findArgByName(fn, b_name);
    injectNoOverflowAssume(fn, a, b);
  }
  return out;
}

// Build the standalone assume-check TvUnit for the mul pattern.
// @src: takes the pre-extension inputs, reruns the sext/zext chain, computes
//       smul.with.overflow, returns !ovf.
// @tgt: returns true unconditionally.
TvUnit buildAssumeCheck(const ExtSource &a, const ExtSource &b,
                        llvm::Type *mul_ty, llvm::Module &parent_module,
                        llvm::LLVMContext &ctx, const std::string &diag_name) {
  TvUnit out;
  out.name = diag_name;
  out.module = std::make_unique<llvm::Module>("assume_check", ctx);
  out.module->setDataLayout(parent_module.getDataLayout());
  out.module->setTargetTriple(parent_module.getTargetTriple());

  llvm::Type *i1 = llvm::Type::getInt1Ty(ctx);
  bool same_src = (a.src_name == b.src_name);
  std::vector<std::string> names = {a.src_name};
  std::vector<llvm::Type *> params = {a.src_ty};
  if (!same_src) {
    names.push_back(b.src_name);
    params.push_back(b.src_ty);
  }

  llvm::FunctionType *fn_ty =
      llvm::FunctionType::get(i1, params, /*isVarArg=*/false);
  out.src_fn = llvm::Function::Create(fn_ty, llvm::Function::ExternalLinkage,
                                      "src", out.module.get());
  out.tgt_fn = llvm::Function::Create(fn_ty, llvm::Function::ExternalLinkage,
                                      "tgt", out.module.get());
  for (size_t i = 0; i < names.size(); ++i) {
    out.src_fn->getArg(i)->setName(names[i]);
    out.tgt_fn->getArg(i)->setName(names[i]);
  }

  auto buildExt = [&](llvm::IRBuilder<> &bld, llvm::Value *v,
                      const ExtSource &e,
                      const llvm::Twine &n) -> llvm::Value * {
    return e.is_signed ? bld.CreateSExt(v, mul_ty, n)
                       : bld.CreateZExt(v, mul_ty, n);
  };

  {
    llvm::BasicBlock *bb = llvm::BasicBlock::Create(ctx, "entry", out.src_fn);
    llvm::IRBuilder<> bld(bb);
    llvm::Argument *a_arg = out.src_fn->getArg(0);
    llvm::Argument *b_arg = same_src ? a_arg : out.src_fn->getArg(1);
    llvm::Value *a_ext = buildExt(bld, a_arg, a, "a_ext");
    llvm::Value *b_ext = buildExt(bld, b_arg, b, "b_ext");
    llvm::Function *smul_ovf = llvm::Intrinsic::getOrInsertDeclaration(
        out.module.get(), llvm::Intrinsic::smul_with_overflow, {mul_ty});
    llvm::CallInst *call = bld.CreateCall(smul_ovf, {a_ext, b_ext}, "ovf_pair");
    llvm::Value *ovf_bit = bld.CreateExtractValue(call, {1}, "ovf_bit");
    llvm::Value *not_ovf =
        bld.CreateXor(ovf_bit, llvm::ConstantInt::getTrue(ctx), "not_ovf");
    bld.CreateRet(not_ovf);
  }
  {
    llvm::BasicBlock *bb = llvm::BasicBlock::Create(ctx, "entry", out.tgt_fn);
    llvm::IRBuilder<> bld(bb);
    bld.CreateRet(llvm::ConstantInt::getTrue(ctx));
  }
  return out;
}

// ============================================================
// Pattern 2 helpers: freeze(arg) drop when arg is bounded shl
// ============================================================

// Scan @src for a single freeze whose operand is a named function argument;
// verify @tgt has no freeze. Returns the argument's SSA name or "".
std::string findFrozenParamName(const TvUnit &unit) {
  std::string result;
  for (llvm::BasicBlock &bb : *unit.src_fn)
    for (llvm::Instruction &I : bb) {
      if (!llvm::isa<llvm::FreezeInst>(&I))
        continue;
      llvm::Value *op = I.getOperand(0);
      if (!llvm::isa<llvm::Argument>(op) || !op->hasName())
        return "";
      if (!result.empty())
        return ""; // more than one freeze-of-arg
      result = op->getName().str();
    }
  if (result.empty())
    return "";
  for (llvm::BasicBlock &bb : *unit.tgt_fn)
    for (llvm::Instruction &I : bb)
      if (llvm::isa<llvm::FreezeInst>(&I))
        return "";
  return result;
}

// Prepend `freeze arg; icmp eq arg, frozen; assume(cond)` to fn's entry.
void injectNoPoisonAssume(llvm::Function *fn, const std::string &param_name) {
  llvm::Argument *arg = findArgByName(fn, param_name);
  if (!arg)
    return;
  llvm::BasicBlock &entry = fn->getEntryBlock();
  llvm::IRBuilder<> bld(&entry, entry.begin());
  llvm::Value *frozen = bld.CreateFreeze(arg, "frozen");
  llvm::Value *cond = bld.CreateICmpEQ(arg, frozen, "is_non_poison");
  llvm::Function *assume_fn = llvm::Intrinsic::getOrInsertDeclaration(
      fn->getParent(), llvm::Intrinsic::assume);
  bld.CreateCall(assume_fn, {cond});
}

// Clone the TvUnit and inject no-poison assumes on both sides.
TvUnit buildNoPoisonModifiedTvUnit(const TvUnit &original,
                                   const std::string &param_name,
                                   const std::string &diag_name) {
  TvUnit out;
  out.name = diag_name;
  llvm::ValueToValueMapTy vmap;
  out.module = llvm::CloneModule(*original.module, vmap);
  out.src_fn = out.module->getFunction("src");
  out.tgt_fn = out.module->getFunction("tgt");
  for (llvm::Function *fn : {out.src_fn, out.tgt_fn})
    injectNoPoisonAssume(fn, param_name);
  return out;
}

// Build the standalone assume-check TvUnit for the freeze-drop pattern.
// @src: rebuild `slice`, freeze the root value, icmp eq to check non-poison.
// @tgt: return true unconditionally.
TvUnit buildFreezeDropAssumeCheck(const BackwardSlice &slice,
                                  const std::string &frozen_name,
                                  llvm::Module &parent_module,
                                  llvm::LLVMContext &ctx,
                                  const std::string &diag_name) {
  TvUnit out;
  out.name = diag_name;
  out.module = std::make_unique<llvm::Module>("assume_check_freeze", ctx);
  out.module->setDataLayout(parent_module.getDataLayout());
  out.module->setTargetTriple(parent_module.getTargetTriple());

  llvm::Type *i1 = llvm::Type::getInt1Ty(ctx);
  std::vector<llvm::Type *> param_types;
  for (auto *arg : slice.arg_roots)
    param_types.push_back(arg->getType());

  llvm::FunctionType *fn_ty = llvm::FunctionType::get(i1, param_types, false);
  out.src_fn = llvm::Function::Create(fn_ty, llvm::Function::ExternalLinkage,
                                      "src", out.module.get());
  out.tgt_fn = llvm::Function::Create(fn_ty, llvm::Function::ExternalLinkage,
                                      "tgt", out.module.get());
  for (size_t i = 0; i < slice.arg_roots.size(); ++i) {
    out.src_fn->getArg(i)->setName(slice.arg_roots[i]->getName());
    out.tgt_fn->getArg(i)->setName(slice.arg_roots[i]->getName());
  }

  {
    llvm::BasicBlock *bb = llvm::BasicBlock::Create(ctx, "entry", out.src_fn);
    llvm::IRBuilder<> bld(bb);
    std::map<llvm::Value *, llvm::Value *> vmap;
    for (size_t i = 0; i < slice.arg_roots.size(); ++i)
      vmap[slice.arg_roots[i]] = out.src_fn->getArg(i);

    llvm::Value *root_clone = nullptr;
    for (llvm::Instruction *orig : slice.insts) {
      llvm::Instruction *cloned = orig->clone();
      if (orig->hasName())
        cloned->setName(orig->getName());
      for (unsigned i = 0; i < cloned->getNumOperands(); ++i) {
        auto it = vmap.find(orig->getOperand(i));
        if (it != vmap.end())
          cloned->setOperand(i, it->second);
      }
      bld.Insert(cloned);
      vmap[orig] = cloned;
      if (orig->hasName() && orig->getName().str() == frozen_name)
        root_clone = cloned;
    }

    if (root_clone) {
      llvm::Value *frozen_result = bld.CreateFreeze(root_clone, "frozen");
      llvm::Value *cond = bld.CreateICmpEQ(root_clone, frozen_result, "cond");
      bld.CreateRet(cond);
    } else {
      bld.CreateRet(llvm::ConstantInt::getTrue(ctx));
    }
  }
  {
    llvm::BasicBlock *bb = llvm::BasicBlock::Create(ctx, "entry", out.tgt_fn);
    llvm::IRBuilder<> bld(bb);
    bld.CreateRet(llvm::ConstantInt::getTrue(ctx));
  }
  return out;
}

// ============================================================
// proposeFromRanges helpers: generic range-bound assume injection
// ============================================================

// Inject `assume(icmp ule arg, hi)` — and `assume(icmp uge arg, lo)` when
// lo > 0 — at the head of fn's entry block for the named argument.
void injectUBoundAssume(llvm::Function *fn, const std::string &name,
                        const llvm::APInt &lo, const llvm::APInt &hi) {
  llvm::Argument *arg = findArgByName(fn, name);
  if (!arg)
    return;
  llvm::BasicBlock &entry = fn->getEntryBlock();
  llvm::IRBuilder<> bld(&entry, entry.begin());
  llvm::Type *ty = arg->getType();

  llvm::Value *hi_c = llvm::ConstantInt::get(ty, hi);
  llvm::Value *cond = bld.CreateICmpULE(arg, hi_c, name + "_ub_ok");

  if (lo != llvm::APInt::getZero(lo.getBitWidth())) {
    llvm::Value *lo_c = llvm::ConstantInt::get(ty, lo);
    llvm::Value *lb_ok = bld.CreateICmpUGE(arg, lo_c, name + "_lb_ok");
    cond = bld.CreateAnd(cond, lb_ok, name + "_bounds_ok");
  }

  llvm::Function *assume_fn = llvm::Intrinsic::getOrInsertDeclaration(
      fn->getParent(), llvm::Intrinsic::assume);
  bld.CreateCall(assume_fn, {cond});
}

// Operand with a provably bounded unsigned range in parent_src.
struct BoundedOp {
  std::string name;    // SSA name in both unit.src_fn (as arg) and parent_src
  BackwardSlice slice; // backward slice in parent_src
  llvm::APInt lo, hi;  // closed unsigned interval [lo, hi]
};

// Build the assume-check TvUnit for proposeFromRanges.
// @src: rebuilds the union of all bounded-op slices and returns
//       the conjunction of all range-bound predicates.
// @tgt: returns true unconditionally.
TvUnit buildCombinedRangeBoundCheck(const std::vector<BoundedOp> &bounded,
                                    llvm::Function &parent_src,
                                    llvm::Module &parent_module,
                                    llvm::LLVMContext &ctx,
                                    const std::string &diag_name) {
  TvUnit out;
  out.name = diag_name;
  out.module = std::make_unique<llvm::Module>("range_bound_check", ctx);
  out.module->setDataLayout(parent_module.getDataLayout());
  out.module->setTargetTriple(parent_module.getTargetTriple());

  llvm::Type *i1 = llvm::Type::getInt1Ty(ctx);

  // Union of arg_roots from all slices, sorted by argno, deduped.
  std::map<unsigned, llvm::Argument *> arg_map;
  for (auto &bo : bounded)
    for (auto *arg : bo.slice.arg_roots)
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

  // @src
  {
    llvm::BasicBlock *bb = llvm::BasicBlock::Create(ctx, "entry", out.src_fn);
    llvm::IRBuilder<> bld(bb);

    // vmap: old arg/inst ptr → rebuilt Value*
    std::map<llvm::Value *, llvm::Value *> vmap;
    for (size_t i = 0; i < all_args.size(); ++i)
      vmap[all_args[i]] = out.src_fn->getArg(i);

    // Collect union of insts in program order (iterate parent_src for ordering).
    std::set<llvm::Instruction *> inst_set;
    for (auto &bo : bounded)
      for (auto *I : bo.slice.insts)
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

    // Build range-bound predicate for each bounded operand.
    llvm::Value *result = nullptr;
    for (auto &bo : bounded) {
      llvm::Value *parent_val = findValueByName(bo.name, parent_src);
      if (!parent_val)
        continue;
      auto vit = vmap.find(parent_val);
      if (vit == vmap.end())
        continue;
      llvm::Value *rebuilt = vit->second;
      llvm::Type *ty = rebuilt->getType();

      llvm::Value *hi_c = llvm::ConstantInt::get(ty, bo.hi);
      llvm::Value *this_ok = bld.CreateICmpULE(rebuilt, hi_c, bo.name + "_ub");

      if (bo.lo != llvm::APInt::getZero(bo.lo.getBitWidth())) {
        llvm::Value *lo_c = llvm::ConstantInt::get(ty, bo.lo);
        llvm::Value *lb_ok = bld.CreateICmpUGE(rebuilt, lo_c, bo.name + "_lb");
        this_ok = bld.CreateAnd(this_ok, lb_ok, bo.name + "_ok");
      }

      result = result ? bld.CreateAnd(result, this_ok, "all_ok") : this_ok;
    }

    bld.CreateRet(result ? result : llvm::ConstantInt::getTrue(ctx));
  }

  // @tgt
  {
    llvm::BasicBlock *bb = llvm::BasicBlock::Create(ctx, "entry", out.tgt_fn);
    llvm::IRBuilder<> bld(bb);
    bld.CreateRet(llvm::ConstantInt::getTrue(ctx));
  }

  return out;
}

// ============================================================
// Registered patterns
// ============================================================

// kPatterns is iterated by proposeAssume in order. To add a new pattern,
// append a lambda here. See proposer.h for the full documentation.
const std::vector<AssumeProposerFn> kPatterns = {

  // Pattern: mul A, B → mul nsw A', B' when both A, B trace through a
  // single integer extension (sext/zext) in parent @src. Proposes the
  // assume "smul(A, B) doesn't signed-overflow".
  [](const TvUnit &unit, llvm::Function &parent_src,
     llvm::Module &parent_module,
     llvm::LLVMContext &ctx) -> std::optional<AssumedTvUnit> {
    using namespace llvm::PatternMatch;

    llvm::Instruction *src_inst = singleNonTerminator(*unit.src_fn);
    llvm::Instruction *tgt_inst = singleNonTerminator(*unit.tgt_fn);
    if (!src_inst || !tgt_inst)
      return std::nullopt;

    // tgt must be nsw mul; src must be plain mul (no nsw).
    llvm::Value *a = nullptr, *b = nullptr;
    if (!match(tgt_inst, m_NSWMul(m_Value(a), m_Value(b))))
      return std::nullopt;
    if (!tgt_inst->getType()->isIntegerTy())
      return std::nullopt;
    if (src_inst->getOpcode() != llvm::Instruction::Mul)
      return std::nullopt;
    if (llvm::cast<llvm::OverflowingBinaryOperator>(src_inst)->hasNoSignedWrap())
      return std::nullopt;

    // Operands must match (commutativity allowed), identified by SSA name.
    auto getName = [](llvm::Value *V) -> std::string {
      return V->hasName() ? V->getName().str() : "";
    };
    std::array<std::string, 2> src_ops = {getName(src_inst->getOperand(0)),
                                          getName(src_inst->getOperand(1))};
    std::array<std::string, 2> tgt_ops = {getName(a), getName(b)};
    std::sort(src_ops.begin(), src_ops.end());
    std::sort(tgt_ops.begin(), tgt_ops.end());
    if (src_ops != tgt_ops || src_ops[0].empty())
      return std::nullopt;

    llvm::Type *mul_ty = tgt_inst->getType();
    auto a_ext = findExtSource(src_ops[0], parent_src, mul_ty);
    if (!a_ext)
      return std::nullopt;
    auto b_ext = findExtSource(src_ops[1], parent_src, mul_ty);
    if (!b_ext)
      return std::nullopt;

    AssumedTvUnit out;
    out.proposer_name = "NoOverflowMulFromExt";
    out.modified_unit =
        buildModifiedTvUnit(unit, src_ops[0], src_ops[1], unit.name + "+assume");
    out.assume_check = buildAssumeCheck(*a_ext, *b_ext, mul_ty, parent_module,
                                        ctx, unit.name + "/assume-check");
    return out;
  },

  // Pattern: freeze(arg) present in @src, absent in @tgt, and the frozen
  // value is provably well-defined (undef_free && poison_free) in parent @src
  // via range analysis. Proposes the assume "arg is non-poison / non-undef"
  // (i.e. freeze is the identity). Works for any computation that range
  // analysis can prove well-defined — not limited to any specific opcode.
  [](const TvUnit &unit, llvm::Function &parent_src,
     llvm::Module &parent_module,
     llvm::LLVMContext &ctx) -> std::optional<AssumedTvUnit> {
    std::string frozen_name = findFrozenParamName(unit);
    if (frozen_name.empty())
      return std::nullopt;

    auto slice = collectBackwardSlice(frozen_name, parent_src);
    if (!slice)
      return std::nullopt;

    // Seed arg_roots as well-defined: optimistic, but the assume-check is
    // the soundness gate — alive2 rejects if the claim doesn't hold.
    RangeMap seed;
    for (auto *arg : slice->arg_roots) {
      KnownRange r;
      r.undef_free = true;
      r.poison_free = true;
      seed[arg] = r;
    }
    RangeMap ranges = computeRanges(slice->insts, seed);

    // Find the frozen value's entry and check it is well-defined.
    llvm::Value *frozen_def = nullptr;
    for (llvm::BasicBlock &bb : parent_src)
      for (llvm::Instruction &I : bb)
        if (I.hasName() && I.getName().str() == frozen_name)
          frozen_def = &I;
    if (!frozen_def)
      return std::nullopt;

    auto it = ranges.find(frozen_def);
    if (it == ranges.end() || !it->second.well_defined())
      return std::nullopt;

    AssumedTvUnit out;
    out.proposer_name = "FreezeDropFromRange";
    out.modified_unit =
        buildNoPoisonModifiedTvUnit(unit, frozen_name, unit.name + "+assume");
    out.assume_check =
        buildFreezeDropAssumeCheck(*slice, frozen_name, parent_module, ctx,
                                   unit.name + "/assume-check");
    return out;
  },

}; // kPatterns

// ============================================================
// Range-based fallback proposer
// ============================================================

// Generic fallback: propose upper (and lower, if non-zero) bound assumes for
// operands of a single-instruction cut where tgt gains nsw or nuw vs src,
// and range analysis on parent_src can bound those operands.
//
// The soundness gate (assume_check) rebuilds the combined backward slice of
// all bounded operands and proves the bounds hold unconditionally.
std::optional<AssumedTvUnit> proposeFromRanges(const TvUnit &unit,
                                               llvm::Function &parent_src,
                                               llvm::Module &parent_module,
                                               llvm::LLVMContext &ctx) {
  // Only handles single-instruction cuts.
  llvm::Instruction *src_inst = singleNonTerminator(*unit.src_fn);
  llvm::Instruction *tgt_inst = singleNonTerminator(*unit.tgt_fn);
  if (!src_inst || !tgt_inst)
    return std::nullopt;
  if (src_inst->getOpcode() != tgt_inst->getOpcode())
    return std::nullopt;

  // tgt must have gained at least one overflow flag that src lacks.
  auto *src_obo = llvm::dyn_cast<llvm::OverflowingBinaryOperator>(src_inst);
  auto *tgt_obo = llvm::dyn_cast<llvm::OverflowingBinaryOperator>(tgt_inst);
  if (!src_obo || !tgt_obo)
    return std::nullopt;
  bool added_nsw = !src_obo->hasNoSignedWrap() && tgt_obo->hasNoSignedWrap();
  bool added_nuw = !src_obo->hasNoUnsignedWrap() && tgt_obo->hasNoUnsignedWrap();
  if (!added_nsw && !added_nuw)
    return std::nullopt;

  // Collect parent_src instructions and run range analysis.
  std::vector<llvm::Instruction *> parent_insts;
  for (llvm::BasicBlock &bb : parent_src)
    for (llvm::Instruction &I : bb)
      if (!I.isTerminator())
        parent_insts.push_back(&I);
  RangeMap ranges = computeRanges(parent_insts);

  // For each named operand of src_inst, check if it has a useful bounded range
  // in parent_src (must be a computed instruction so we can collect its slice).
  auto getName = [](llvm::Value *V) -> std::string {
    return V->hasName() ? V->getName().str() : "";
  };
  std::vector<BoundedOp> bounded;
  for (unsigned i = 0; i < src_inst->getNumOperands(); ++i) {
    std::string name = getName(src_inst->getOperand(i));
    if (name.empty())
      continue;
    llvm::Value *parent_val = findValueByName(name, parent_src);
    if (!parent_val)
      continue;
    auto it = ranges.find(parent_val);
    if (it == ranges.end() || !it->second.u)
      continue;
    auto [lo, hi] = *it->second.u;
    // Skip trivial upper bound (UINT_MAX) — not constraining.
    if (hi.isAllOnes())
      continue;
    // Must be a computable instruction (not a direct arg) to prove bounds.
    auto slice = collectBackwardSlice(name, parent_src);
    if (!slice)
      continue;
    // Safety: skip if the slice contains PHI nodes (not straight-line).
    bool has_phi = false;
    for (auto *I : slice->insts)
      if (llvm::isa<llvm::PHINode>(I)) {
        has_phi = true;
        break;
      }
    if (has_phi)
      continue;
    bounded.push_back({name, std::move(*slice), lo, hi});
  }

  if (bounded.empty())
    return std::nullopt;

  // Build the modified unit: clone original + inject bound assumes.
  TvUnit modified;
  modified.name = unit.name + "+range-assume";
  {
    llvm::ValueToValueMapTy vmap;
    modified.module = llvm::CloneModule(*unit.module, vmap);
    modified.src_fn = modified.module->getFunction("src");
    modified.tgt_fn = modified.module->getFunction("tgt");
    for (auto &bo : bounded)
      for (llvm::Function *fn : {modified.src_fn, modified.tgt_fn})
        injectUBoundAssume(fn, bo.name, bo.lo, bo.hi);
  }

  TvUnit assume_check = buildCombinedRangeBoundCheck(
      bounded, parent_src, parent_module, ctx, unit.name + "/range-check");

  AssumedTvUnit out;
  out.proposer_name = "FromRanges";
  out.modified_unit = std::move(modified);
  out.assume_check = std::move(assume_check);
  return out;
}

} // namespace

// ============================================================
// Public API
// ============================================================

std::optional<AssumedTvUnit> proposeAssume(const TvUnit &original_unit,
                                           llvm::Function &parent_src,
                                           llvm::Module &parent_module,
                                           llvm::LLVMContext &ctx) {
  for (const AssumeProposerFn &fn : kPatterns)
    if (auto r = fn(original_unit, parent_src, parent_module, ctx))
      return r;
  return proposeFromRanges(original_unit, parent_src, parent_module, ctx);
}

} // namespace alive_tv_next
