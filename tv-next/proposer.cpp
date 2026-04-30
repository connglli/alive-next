#include "tv-next/proposer.h"

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
  out.modified_cut =
      buildModifiedTvUnit(original, a_name, b_name, original.name + "+assume");
  out.assume_check = buildAssumeCheck(*a_src, *b_src, mul_ty, parent_module,
                                      ctx, original.name + "/assume-check");
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
  return std::nullopt;
}

} // namespace alive_tv_next
