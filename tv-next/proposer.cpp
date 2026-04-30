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
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/Cloning.h"
#include "llvm/Transforms/Utils/ValueMapper.h"

#include <algorithm>
#include <map>
#include <vector>

namespace alive_tv_next {

namespace {

// Find the function's single non-terminator instruction (Phase 3 expects
// 1-position cuts only). Returns nullptr if the cut has 0 or >1 such
// instructions.
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

// Description of a value `name` traced one level back through an extension
// instruction in the parent function. `is_signed` tracks sext (true) vs.
// zext (false). `src_name` is the SSA name of the value being extended;
// `src_ty` is its (narrower) type. The destination type is the mul's
// type and is implied by context.
struct ExtSource {
  std::string src_name;
  llvm::Type *src_ty = nullptr;
  bool is_signed = false;
};

// Look up `name` in `parent_src`. If it names a `sext` or `zext`
// integer-extension to `expected_dst_ty`, return its source description
// (the value being extended, which is what the assume-check ranges over).
// Returns nullopt if `name` doesn't resolve to a single such extension
// or if either source/dest is non-integer.
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

llvm::Argument *findArgByName(llvm::Function *fn, const std::string &name) {
  for (llvm::Argument &arg : fn->args())
    if (arg.getName().str() == name)
      return &arg;
  return nullptr;
}

// Inject the no-overflow assume sequence at the head of `fn`'s entry block:
//   %ovf_pair = call {i64, i1} @llvm.smul.with.overflow.i64(<a>, <b>)
//   %ovf_bit  = extractvalue {i64, i1} %ovf_pair, 1
//   %not_ovf  = xor i1 %ovf_bit, true
//   call void @llvm.assume(i1 %not_ovf)
void injectNoOverflowAssume(llvm::Function *fn, llvm::Argument *a,
                            llvm::Argument *b) {
  llvm::LLVMContext &ctx = fn->getContext();
  llvm::Module *M = fn->getParent();
  llvm::BasicBlock &entry = fn->getEntryBlock();
  llvm::IRBuilder<> bld(&entry, entry.begin());

  llvm::Type *i64 = llvm::Type::getInt64Ty(ctx);

  llvm::Function *smul_ovf = llvm::Intrinsic::getOrInsertDeclaration(
      M, llvm::Intrinsic::smul_with_overflow, {i64});
  llvm::CallInst *call = bld.CreateCall(smul_ovf, {a, b}, "ovf_pair");
  llvm::Value *ovf_bit = bld.CreateExtractValue(call, {1}, "ovf_bit");
  llvm::Value *not_ovf =
      bld.CreateXor(ovf_bit, llvm::ConstantInt::getTrue(ctx), "not_ovf");

  llvm::Function *assume_fn =
      llvm::Intrinsic::getOrInsertDeclaration(M, llvm::Intrinsic::assume);
  bld.CreateCall(assume_fn, {not_ovf});
}

// Clone the original TvUnit's module and inject an assume on each side.
// `a_name` / `b_name` are the SSA names of the two unit parameters
// the assume ranges over (i.e. the mul's operands).
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

// Build the standalone assume-check TvUnit. Takes the parent's pre-extension
// inputs as parameters; @src reruns the sext/zext + no-signed-overflow
// predicate; @tgt always returns true. Verifying this checks the
// precondition holds in the parent's input space.
TvUnit buildAssumeCheck(const ExtSource &a, const ExtSource &b,
                        llvm::Type *mul_ty, llvm::Module &parent_module,
                        llvm::LLVMContext &ctx, const std::string &diag_name) {
  TvUnit out;
  out.name = diag_name;
  out.module = std::make_unique<llvm::Module>("assume_check", ctx);
  out.module->setDataLayout(parent_module.getDataLayout());
  out.module->setTargetTriple(parent_module.getTargetTriple());

  llvm::Type *i1 = llvm::Type::getInt1Ty(ctx);

  // Dedup by source SSA name — when both extensions trace back to the same
  // value, the assume ranges over a single parameter.
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

// Recognize the rewrite "mul A, B → mul nsw A', B'" where {A,B} = {A',B'}
// (commutativity allowed) and both A, B trace back through a single
// integer extension (sext/zext) in the parent @src. Propose the assume
// "no signed overflow" via `llvm.smul.with.overflow.iN` where iN is the
// mul's type. alive2 acts as the soundness gate: the assume-check fires
// the proof, so feasibility for arbitrary (M, K, N) bitwidth combos is
// decided there rather than encoded as arithmetic here.
std::optional<AssumedTvUnit>
tryNoOverflowMulFromExt(const TvUnit &original, llvm::Function &parent_src,
                        llvm::Module &parent_module, llvm::LLVMContext &ctx) {
  llvm::Instruction *src_inst = singleNonTerminator(*original.src_fn);
  llvm::Instruction *tgt_inst = singleNonTerminator(*original.tgt_fn);
  if (!src_inst || !tgt_inst)
    return std::nullopt;

  auto *src_mul = llvm::dyn_cast<llvm::BinaryOperator>(src_inst);
  auto *tgt_mul = llvm::dyn_cast<llvm::BinaryOperator>(tgt_inst);
  if (!src_mul || !tgt_mul)
    return std::nullopt;
  if (src_mul->getOpcode() != llvm::Instruction::Mul ||
      tgt_mul->getOpcode() != llvm::Instruction::Mul)
    return std::nullopt;
  if (!src_mul->getType()->isIntegerTy())
    return std::nullopt;

  // The rewrite we cover: tgt is nsw, src is plain.
  if (!tgt_mul->hasNoSignedWrap() || src_mul->hasNoSignedWrap())
    return std::nullopt;

  auto getName = [](llvm::Value *V) -> std::string {
    return V->hasName() ? V->getName().str() : std::string{};
  };
  std::vector<std::string> src_ops = {getName(src_mul->getOperand(0)),
                                      getName(src_mul->getOperand(1))};
  std::vector<std::string> tgt_ops = {getName(tgt_mul->getOperand(0)),
                                      getName(tgt_mul->getOperand(1))};
  std::sort(src_ops.begin(), src_ops.end());
  std::sort(tgt_ops.begin(), tgt_ops.end());
  if (src_ops != tgt_ops)
    return std::nullopt;
  if (src_ops[0].empty() || src_ops[1].empty())
    return std::nullopt;

  const std::string &a_name = src_ops[0];
  const std::string &b_name = src_ops[1];

  llvm::Type *mul_ty = src_mul->getType();
  auto a_src = findExtSource(a_name, parent_src, mul_ty);
  if (!a_src)
    return std::nullopt;
  auto b_src = findExtSource(b_name, parent_src, mul_ty);
  if (!b_src)
    return std::nullopt;

  AssumedTvUnit out;
  out.proposer_name = "tryNoOverflowMulFromExt";
  out.modified_unit =
      buildModifiedTvUnit(original, a_name, b_name, original.name + "+assume");
  out.assume_check = buildAssumeCheck(*a_src, *b_src, mul_ty, parent_module,
                                      ctx, original.name + "/assume-check");
  return out;
}

// --- freeze-drop proposer (Phase 5) ---

// Scan @src for a single freeze whose operand is a function argument;
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

// Prepend `freeze arg; icmp eq arg, frozen; assume(cond)` to `fn`'s entry.
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

// Clone the TvUnit and inject a no-poison assume on `param_name` in both sides.
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

// Build the standalone assume-check TvUnit:
//   @src: rebuild `slice`, then freeze(root) and icmp eq to check non-poison.
//   @tgt: return true unconditionally.
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

  // @src: rebuild slice, freeze the root value, icmp eq, ret
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

  // @tgt: return true
  {
    llvm::BasicBlock *bb = llvm::BasicBlock::Create(ctx, "entry", out.tgt_fn);
    llvm::IRBuilder<> bld(bb);
    bld.CreateRet(llvm::ConstantInt::getTrue(ctx));
  }

  return out;
}

// Propose "freeze %v is identity" for the pattern:
//   @src has a freeze of a function argument `%frozen_name`; @tgt has none.
//   In parent_src, `%frozen_name = shl %x, %amt` where range(%amt) < bitwidth.
//
// Collects the backward slice of the frozen value first, runs computeRanges
// on it to bound the shift amount, then builds the assume-check TvUnit.
std::optional<AssumedTvUnit> tryFreezeDropFromRange(const TvUnit &original,
                                                    llvm::Function &parent_src,
                                                    llvm::Module &parent_module,
                                                    llvm::LLVMContext &ctx) {
  std::string frozen_name = findFrozenParamName(original);
  if (frozen_name.empty())
    return std::nullopt;

  llvm::Instruction *frozen_def = nullptr;
  for (llvm::BasicBlock &bb : parent_src)
    for (llvm::Instruction &I : bb)
      if (I.hasName() && I.getName().str() == frozen_name)
        frozen_def = &I;
  if (!frozen_def)
    return std::nullopt;

  auto *shl_inst = llvm::dyn_cast<llvm::BinaryOperator>(frozen_def);
  if (!shl_inst || shl_inst->getOpcode() != llvm::Instruction::Shl)
    return std::nullopt;

  unsigned bitwidth = shl_inst->getType()->getIntegerBitWidth();
  llvm::Value *shift_amt = shl_inst->getOperand(1);

  // Collect the backward slice first — needed both for range analysis and for
  // building the assume-check TvUnit.
  auto slice = collectBackwardSlice(frozen_name, parent_src);
  if (!slice)
    return std::nullopt;

  // Check that the shift amount is provably < bitwidth (non-poison from shl).
  bool amt_bounded = false;
  if (auto *CI = llvm::dyn_cast<llvm::ConstantInt>(shift_amt)) {
    amt_bounded = CI->getValue().ult(bitwidth);
  } else {
    auto ranges = computeRanges(slice->insts);
    auto it = ranges.find(shift_amt);
    amt_bounded = (it != ranges.end() && it->second.u &&
                   it->second.u->second.ult(bitwidth));
  }
  if (!amt_bounded)
    return std::nullopt;

  AssumedTvUnit out;
  out.proposer_name = "tryFreezeDropFromRange";
  out.modified_unit = buildNoPoisonModifiedTvUnit(original, frozen_name,
                                                  original.name + "+assume");
  out.assume_check = buildFreezeDropAssumeCheck(
      *slice, frozen_name, parent_module, ctx, original.name + "/assume-check");
  return out;
}

} // namespace

std::optional<AssumedTvUnit> proposeAssume(const TvUnit &original_unit,
                                           llvm::Function &parent_src,
                                           llvm::Module &parent_module,
                                           llvm::LLVMContext &ctx) {
  if (auto r = tryNoOverflowMulFromExt(original_unit, parent_src, parent_module,
                                       ctx))
    return r;
  if (auto r =
          tryFreezeDropFromRange(original_unit, parent_src, parent_module, ctx))
    return r;
  return std::nullopt;
}

} // namespace alive_tv_next
