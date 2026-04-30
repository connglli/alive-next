#include "tv-next/cut.h"

#include "llvm/IR/Argument.h"
#include "llvm/IR/BasicBlock.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/Instruction.h"
#include "llvm/Support/raw_ostream.h"

#include <map>
#include <set>
#include <utility>
#include <vector>

namespace alive_tv_next {

namespace {

// Walk the group's instructions on one side, collecting (ssa_name, type)
// pairs for non-constant operands that are *external* (not defined by an
// earlier instruction in the same group). Preserves first-seen order.
// Returns std::nullopt if any non-constant external operand lacks a name.
std::optional<std::vector<std::pair<std::string, llvm::Type *>>>
collectExternalOperands(
    const std::vector<llvm::Instruction *> &group_insts,
    const std::set<llvm::Instruction *> &internal) {
  std::vector<std::pair<std::string, llvm::Type *>> out;
  std::set<std::string> seen;

  for (const llvm::Instruction *I : group_insts) {
    for (const llvm::Use &U : I->operands()) {
      llvm::Value *V = U.get();
      if (llvm::isa<llvm::Constant>(V))
        continue;
      if (auto *opI = llvm::dyn_cast<llvm::Instruction>(V)) {
        if (internal.count(opI))
          continue;
      }
      if (!V->hasName()) {
        llvm::errs()
            << "alive-tv-next: cut lift requires named external operands; "
            << "anonymous operand on instruction:\n  ";
        I->print(llvm::errs());
        llvm::errs() << "\n";
        return std::nullopt;
      }
      std::string name = V->getName().str();
      if (seen.insert(name).second)
        out.emplace_back(std::move(name), V->getType());
    }
  }
  return out;
}

// Union two (name, type) lists, preserving first-seen order. On a name
// collision with differing types, prints a diagnostic and returns nullopt.
std::optional<std::vector<std::pair<std::string, llvm::Type *>>>
unionNamedOperands(
    const std::vector<std::pair<std::string, llvm::Type *>> &src_ops,
    const std::vector<std::pair<std::string, llvm::Type *>> &tgt_ops) {
  std::vector<std::pair<std::string, llvm::Type *>> out;
  std::map<std::string, llvm::Type *> seen;

  auto addOne = [&](const std::pair<std::string, llvm::Type *> &p) -> bool {
    auto it = seen.find(p.first);
    if (it == seen.end()) {
      seen.emplace(p.first, p.second);
      out.push_back(p);
      return true;
    }
    if (it->second != p.second) {
      llvm::errs() << "alive-tv-next: operand '%" << p.first
                   << "' has differing types in src vs tgt\n";
      return false;
    }
    return true;
  };

  for (const auto &p : src_ops)
    if (!addOne(p))
      return std::nullopt;
  for (const auto &p : tgt_ops)
    if (!addOne(p))
      return std::nullopt;

  return out;
}

// Lift one side (src or tgt) of the group: clone each instruction in
// program order, rewire its operands.
//
//   - Constants pass through unchanged.
//   - Internal references map to their cloned counterparts via
//     `orig_to_clone` (built up incrementally as we go).
//   - External references map to function parameters via
//     `name_to_param`, looked up by SSA name.
//
// Returns the cloned exit instruction (last in `group_insts`), used as
// the function's return value.
llvm::Instruction *buildGroupHalf(
    const std::vector<llvm::Instruction *> &group_insts,
    llvm::Function *fn,
    const std::map<std::string, llvm::Argument *> &name_to_param,
    const std::set<llvm::Instruction *> &internal) {
  llvm::LLVMContext &ctx = fn->getContext();
  llvm::BasicBlock *entry = llvm::BasicBlock::Create(ctx, "entry", fn);
  llvm::IRBuilder<> b(entry);

  std::map<const llvm::Instruction *, llvm::Instruction *> orig_to_clone;
  llvm::Instruction *exit = nullptr;

  for (llvm::Instruction *orig : group_insts) {
    llvm::Instruction *cloned = orig->clone();
    if (orig->hasName())
      cloned->setName(orig->getName());

    for (unsigned i = 0; i < cloned->getNumOperands(); ++i) {
      llvm::Value *origOp = orig->getOperand(i);
      if (llvm::isa<llvm::Constant>(origOp)) {
        cloned->setOperand(i, origOp);
        continue;
      }
      if (auto *opI = llvm::dyn_cast<llvm::Instruction>(origOp)) {
        if (internal.count(opI)) {
          // Internal: defined earlier in the same group; map to its clone.
          auto it = orig_to_clone.find(opI);
          // Earlier-defined invariant guaranteed by program-order iteration.
          cloned->setOperand(i, it->second);
          continue;
        }
      }
      // External: map by SSA name. (collectExternalOperands already
      // validated names.)
      auto it = name_to_param.find(origOp->getName().str());
      cloned->setOperand(i, it->second);
    }

    b.Insert(cloned);
    orig_to_clone[orig] = cloned;
    exit = cloned;
  }

  b.CreateRet(exit);
  return exit;
}

}  // namespace

std::optional<Cut> buildGroupCut(const DiffGroup &group,
                                 llvm::Module &parent_module,
                                 llvm::LLVMContext &ctx,
                                 const std::string &diag_name) {
  if (group.positions.empty()) {
    llvm::errs() << "alive-tv-next: " << diag_name << " — empty group\n";
    return std::nullopt;
  }

  // Extract per-side instruction sequences and validate per-position
  // shape constraints.
  std::vector<llvm::Instruction *> src_insts, tgt_insts;
  src_insts.reserve(group.positions.size());
  tgt_insts.reserve(group.positions.size());
  for (const auto &dp : group.positions) {
    if (dp.src_inst->isTerminator() || dp.tgt_inst->isTerminator()) {
      llvm::errs() << "alive-tv-next: " << diag_name
                   << " — cannot lift a terminator\n";
      return std::nullopt;
    }
    if (dp.src_inst->getType() != dp.tgt_inst->getType()) {
      llvm::errs() << "alive-tv-next: " << diag_name
                   << " — src and tgt types differ at position "
                   << dp.inst_idx << "\n";
      return std::nullopt;
    }
    src_insts.push_back(dp.src_inst);
    tgt_insts.push_back(dp.tgt_inst);
  }

  // The group's exit value (last position) determines the cut's return type.
  llvm::Type *result_ty = src_insts.back()->getType();
  if (result_ty->isVoidTy()) {
    llvm::errs() << "alive-tv-next: " << diag_name
                 << " — exit instruction has void result type\n";
    return std::nullopt;
  }

  // Internal sets: instructions defined *within* the group on each side.
  std::set<llvm::Instruction *> src_internal(src_insts.begin(),
                                             src_insts.end());
  std::set<llvm::Instruction *> tgt_internal(tgt_insts.begin(),
                                             tgt_insts.end());

  auto src_externals = collectExternalOperands(src_insts, src_internal);
  if (!src_externals)
    return std::nullopt;
  auto tgt_externals = collectExternalOperands(tgt_insts, tgt_internal);
  if (!tgt_externals)
    return std::nullopt;

  auto unioned = unionNamedOperands(*src_externals, *tgt_externals);
  if (!unioned)
    return std::nullopt;

  // Build the cut module.
  Cut cut;
  cut.name = diag_name;
  cut.module = std::make_unique<llvm::Module>("cut", ctx);
  cut.module->setDataLayout(parent_module.getDataLayout());
  cut.module->setTargetTriple(parent_module.getTargetTriple());

  std::vector<llvm::Type *> param_types;
  param_types.reserve(unioned->size());
  for (const auto &p : *unioned)
    param_types.push_back(p.second);
  llvm::FunctionType *fn_ty =
      llvm::FunctionType::get(result_ty, param_types, /*isVarArg=*/false);

  cut.src_fn = llvm::Function::Create(fn_ty, llvm::Function::ExternalLinkage,
                                      "src", cut.module.get());
  cut.tgt_fn = llvm::Function::Create(fn_ty, llvm::Function::ExternalLinkage,
                                      "tgt", cut.module.get());

  // Name parameters and build per-side name → Argument lookup tables.
  std::map<std::string, llvm::Argument *> src_name_to_param, tgt_name_to_param;
  for (size_t i = 0; i < unioned->size(); ++i) {
    cut.src_fn->getArg(i)->setName((*unioned)[i].first);
    cut.tgt_fn->getArg(i)->setName((*unioned)[i].first);
    src_name_to_param[(*unioned)[i].first] = cut.src_fn->getArg(i);
    tgt_name_to_param[(*unioned)[i].first] = cut.tgt_fn->getArg(i);
  }

  buildGroupHalf(src_insts, cut.src_fn, src_name_to_param, src_internal);
  buildGroupHalf(tgt_insts, cut.tgt_fn, tgt_name_to_param, tgt_internal);

  return cut;
}

}  // namespace alive_tv_next
