#include "analyze.h"

#include "irutil.h"

#include "llvm/Analysis/AssumptionCache.h"
#include "llvm/Analysis/LoopInfo.h"
#include "llvm/Analysis/ScalarEvolution.h"
#include "llvm/Analysis/ScalarEvolutionExpressions.h"
#include "llvm/Analysis/TargetLibraryInfo.h"
#include "llvm/Analysis/ValueTracking.h"
#include "llvm/Config/llvm-config.h"
#include "llvm/IR/ConstantRange.h"
#include "llvm/IR/DataLayout.h"
#include "llvm/IR/Dominators.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/Support/KnownBits.h"
#include "llvm/Support/raw_ostream.h"

namespace llops {

namespace {

std::string apToString(const llvm::APInt &V, unsigned radix, bool isSigned) {
  llvm::SmallVector<char, 24> buf;
  V.toString(buf, radix, isSigned);
  return std::string(buf.data(), buf.size());
}

std::string typeName(const llvm::Type &T) {
  std::string out;
  llvm::raw_string_ostream os(out);
  T.print(os);
  return out;
}

// Known bits, as three masks over the value's width. A bit is unknown when it
// is neither known zero nor known one.
void knownBitsFact(llvm::Value &V, const llvm::DataLayout &DL, llvm::AssumptionCache &AC,
                   const llvm::DominatorTree &DT, const llvm::Instruction *point,
                   llvm::json::Object &fact) {
  llvm::KnownBits KB(V.getType()->getIntegerBitWidth());
#if LLVM_VERSION_MAJOR >= 21
  llvm::computeKnownBits(&V, KB, DL, &AC, point, &DT);
#else
  llvm::computeKnownBits(&V, KB, DL, /*Depth=*/0, &AC, point, &DT);
#endif
  fact["zero_bits"] = "0x" + apToString(KB.Zero, 16, false);
  fact["one_bits"] = "0x" + apToString(KB.One, 16, false);
  fact["unknown_bits"] = "0x" + apToString(~(KB.Zero | KB.One), 16, false);
}

// The signed and the unsigned range are computed separately: LLVM reasons
// about one interpretation at a time and the two answers differ.
void rangeFact(llvm::Value &V, llvm::AssumptionCache &AC, const llvm::DominatorTree &DT,
               const llvm::Instruction *point, llvm::json::Object &fact) {
  llvm::ConstantRange S = llvm::computeConstantRange(&V, /*ForSigned=*/true,
                                                     /*UseInstrInfo=*/true, &AC, point, &DT);
  llvm::ConstantRange U = llvm::computeConstantRange(&V, /*ForSigned=*/false,
                                                     /*UseInstrInfo=*/true, &AC, point, &DT);
  fact["signed_min"] = apToString(S.getSignedMin(), 10, true);
  fact["signed_max"] = apToString(S.getSignedMax(), 10, true);
  fact["unsigned_min"] = apToString(U.getUnsignedMin(), 10, false);
  fact["unsigned_max"] = apToString(U.getUnsignedMax(), 10, false);
}

// Whether a value is defined where it is asked about: `noundef` in the sense
// the attribute has, neither undef nor poison, and the two halves separately
// because they call for different fixes. A value that cannot be poison but
// may be undef is one a freeze settles; a value that may be poison usually got
// that way from a flag, which the src side can drop.
void definedFact(llvm::Value &V, llvm::AssumptionCache &AC, const llvm::DominatorTree &DT,
                 const llvm::Instruction *point, llvm::json::Object &fact) {
  fact["noundef"] = llvm::isGuaranteedNotToBeUndefOrPoison(&V, &AC, point, &DT);
  fact["not_undef"] = llvm::isGuaranteedNotToBeUndef(&V, &AC, point, &DT);
  fact["not_poison"] = llvm::isGuaranteedNotToBePoison(&V, &AC, point, &DT);
}

// What a pointer is known to guarantee, in the shape of the attributes the
// strengthen flow puts on a parameter.
void pointerFact(llvm::Value &V, const llvm::DataLayout &DL, llvm::json::Object &fact) {
  bool canBeNull = true, canBeFreed = true;
  uint64_t bytes = V.getPointerDereferenceableBytes(DL, canBeNull, canBeFreed);
  fact["align"] = V.getPointerAlignment(DL).value();
  fact["dereferenceable"] = bytes;
  fact["nonnull"] = bytes > 0 && !canBeNull;
}

// How a fact spells each kind of expression ScalarEvolution builds.
const char *scevOp(llvm::SCEVTypes type) {
  switch (type) {
  case llvm::scConstant:
    return "const";
  case llvm::scVScale:
    return "vscale";
  case llvm::scTruncate:
    return "trunc";
  case llvm::scZeroExtend:
    return "zext";
  case llvm::scSignExtend:
    return "sext";
  case llvm::scAddExpr:
    return "add";
  case llvm::scMulExpr:
    return "mul";
  case llvm::scUDivExpr:
    return "udiv";
  case llvm::scAddRecExpr:
    return "addrec";
  case llvm::scUMaxExpr:
    return "umax";
  case llvm::scSMaxExpr:
    return "smax";
  case llvm::scUMinExpr:
    return "umin";
  case llvm::scSMinExpr:
    return "smin";
  case llvm::scSequentialUMinExpr:
    return "umin_seq";
  case llvm::scPtrToInt:
    return "ptrtoint";
  case llvm::scUnknown:
    return "value";
  case llvm::scCouldNotCompute:
    return "unknown";
  }
  llvm_unreachable("an expression of no kind");
}

// An expression as a tree: a constant or a value at a leaf, the loop of a
// recurrence, {start,+,step,...} in that loop, and the wrap flags of a sum, a
// product or a recurrence.
llvm::json::Object scevTree(const llvm::SCEV &S, ValueRefs &refs) {
  llvm::json::Object node{{"op", scevOp(S.getSCEVType())}};
  node["type"] = typeName(*S.getType());
  if (const auto *C = llvm::dyn_cast<llvm::SCEVConstant>(&S)) {
    node["value"] = apToString(C->getAPInt(), 10, true);
    return node;
  }
  if (const auto *U = llvm::dyn_cast<llvm::SCEVUnknown>(&S)) {
    node["value"] = refs.print(*U->getValue());
    return node;
  }
  llvm::json::Array operands;
  for (const llvm::SCEV *op : S.operands())
    operands.push_back(scevTree(*op, refs));
  node["operands"] = std::move(operands);
  if (const auto *AR = llvm::dyn_cast<llvm::SCEVAddRecExpr>(&S))
    node["loop"] = refs.print(*AR->getLoop()->getHeader());
  if (llvm::isa<llvm::SCEVAddExpr, llvm::SCEVMulExpr, llvm::SCEVAddRecExpr>(&S)) {
    const auto *N = llvm::cast<llvm::SCEVNAryExpr>(&S);
    llvm::json::Array flags;
    if (N->hasNoUnsignedWrap())
      flags.push_back("nuw");
    if (N->hasNoSignedWrap())
      flags.push_back("nsw");
    if (N->hasNoSelfWrap())
      flags.push_back("nw");
    node["flags"] = std::move(flags);
  }
  return node;
}

} // namespace

llvm::json::Object analyzeCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  auto kind = args.getString("kind");
  if (!text || !kind)
    return errResponse("bad_request", "analyze needs 'module' and 'kind'");
  const llvm::StringRef kinds[] = {"knownbits", "ranges", "pointer", "defined", "scev"};
  if (!llvm::is_contained(kinds, *kind))
    return errResponse(
        "bad_request",
        "analyze 'kind' must be 'knownbits', 'ranges', 'pointer', 'defined' or 'scev'");

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);
  llvm::Module &M = *mwc->mod;

  if (auto d = departure(M))
    return errResponse(d->code, d->message);
  llvm::Function *F = singleFunction(M);
  ValueRefs refs(*F);

  // Facts hold just before the analysis point runs, which defaults to the end
  // of a body of one block; a body of several has no one end. The point is
  // also the context for assumptions, so an llvm.assume that dominates it is
  // taken into account.
  llvm::BasicBlock *BB = singleBlock(*F);
  llvm::Instruction *point = BB ? BB->getTerminator() : nullptr;
  if (auto p = args.getString("point")) {
    point = refs.resolveInst(*p);
    if (!point)
      return errResponse("not_found", "analyze: '" + p->str() + "' is not an instruction");
  }
  if (!point)
    return errResponse("bad_request", "analyze needs a 'point' in a body of several blocks");

  const llvm::DataLayout &DL = M.getDataLayout();
  llvm::AssumptionCache AC(*F);
  // The definedness analysis reads llvm.assume operand bundles, and a bundle
  // counts only where it dominates the point.
  llvm::DominatorTree DT(*F);
  llvm::LoopInfo LI(DT);
  llvm::TargetLibraryInfoImpl TLII(M.getTargetTriple());
  llvm::TargetLibraryInfo TLI(TLII);
  llvm::ScalarEvolution SE(*F, TLI, AC, DT, LI);

  llvm::json::Array facts;
  auto addFact = [&](llvm::Value &V) {
    // Definedness is about a value rather than about arithmetic, so it is the
    // one kind that has something to say about every type.
    bool applies = *kind == "defined"   ? true
                   : *kind == "pointer" ? V.getType()->isPointerTy()
                   : *kind == "scev"    ? SE.isSCEVable(V.getType())
                                        : V.getType()->isIntegerTy();
    if (!applies)
      return; // the analysis has nothing to say about this value
    llvm::json::Object fact;
    fact["value"] = refs.print(V);
    fact["type"] = typeName(*V.getType());
    if (*kind == "scev") {
      const llvm::SCEV *S = SE.getSCEV(&V);
      if (const auto *U = llvm::dyn_cast<llvm::SCEVUnknown>(S); U && U->getValue() == &V)
        return; // ScalarEvolution knows the value only as itself
      fact["scev"] = scevTree(*S, refs);
    } else if (*kind == "knownbits")
      knownBitsFact(V, DL, AC, DT, point, fact);
    else if (*kind == "ranges")
      rangeFact(V, AC, DT, point, fact);
    else if (*kind == "defined")
      definedFact(V, AC, DT, point, fact);
    else
      pointerFact(V, DL, fact);
    facts.emplace_back(std::move(fact));
  };

  // What is defined at the point is what dominates it, which in one block is
  // what comes before it.
  for (auto &arg : F->args())
    addFact(arg);
  for (auto &I : llvm::instructions(*F))
    if (&I != point && !I.getType()->isVoidTy() && DT.dominates(&I, point))
      addFact(I);

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["kind"] = kind->str();
  resp["point"] = refs.print(*point);
  resp["facts"] = std::move(facts);
  return resp;
}

} // namespace llops
