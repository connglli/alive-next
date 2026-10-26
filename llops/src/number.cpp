#include "number.h"

#include "irutil.h"
#include "llvm/ADT/STLExtras.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/ModuleSlotTracker.h"
#include "llvm/IR/Operator.h"
#include "llvm/Support/raw_ostream.h"

namespace llops {

namespace {

// An instruction as the module prints it, on one line: a switch prints its
// cases on lines of their own.
std::string lineOf(const llvm::Instruction &I, llvm::ModuleSlotTracker &mst) {
  std::string text;
  llvm::raw_string_ostream os(text);
  I.print(os, mst);
  llvm::SmallVector<llvm::StringRef> lines;
  llvm::StringRef(text).split(lines, '\n', -1, /*KeepEmpty=*/false);
  for (auto &line : lines)
    line = line.trim();
  return llvm::join(lines, " ");
}

// The line without its result, with poison for every operand the function
// defines and `anywhere`, printed `%_`, for every block, so that two
// instructions doing the same thing to different values or blocks share it.
// The copy prints beside the original, since a copy outside the module would
// spell out what the module implies, such as an address space.
std::string formOf(llvm::Instruction &I, llvm::BasicBlock &anywhere, llvm::ModuleSlotTracker &mst) {
  llvm::Instruction *copy = I.clone();
  copy->insertBefore(I.getIterator());
  for (llvm::Use &U : copy->operands())
    if (llvm::isa<llvm::Instruction, llvm::Argument>(U.get()))
      U.set(llvm::PoisonValue::get(U->getType()));
  for (unsigned k = 0; copy->isTerminator() && k < copy->getNumSuccessors(); ++k)
    copy->setSuccessor(k, &anywhere);
  if (auto *phi = llvm::dyn_cast<llvm::PHINode>(copy))
    for (unsigned k = 0; k < phi->getNumIncomingValues(); ++k)
      phi->setIncomingBlock(k, &anywhere);
  std::string line = lineOf(*copy, mst);
  copy->eraseFromParent();
  if (I.getType()->isVoidTy())
    return line;
  return line.substr(line.find(" = ") + 3);
}

// Its flags in the order LLVM prints them.
llvm::json::Array flagsOf(const llvm::Instruction &I) {
  llvm::json::Array flags;
  auto add = [&](bool set, llvm::StringRef flag) {
    if (set)
      flags.push_back(flag);
  };
  if (const auto *call = llvm::dyn_cast<llvm::CallInst>(&I)) {
    auto kind = call->getTailCallKind();
    add(kind == llvm::CallInst::TCK_Tail, "tail");
    add(kind == llvm::CallInst::TCK_MustTail, "musttail");
    add(kind == llvm::CallInst::TCK_NoTail, "notail");
  }
  if (const auto *gep = llvm::dyn_cast<llvm::GEPOperator>(&I)) {
    add(gep->isInBounds(), "inbounds");
    add(!gep->isInBounds() && gep->hasNoUnsignedSignedWrap(), "nusw");
    add(gep->hasNoUnsignedWrap(), "nuw");
  }
  if (const auto *op = llvm::dyn_cast<llvm::OverflowingBinaryOperator>(&I)) {
    add(op->hasNoUnsignedWrap(), "nuw");
    add(op->hasNoSignedWrap(), "nsw");
  }
  // A trunc carries the same two flags without being an overflowing operator.
  if (const auto *trunc = llvm::dyn_cast<llvm::TruncInst>(&I)) {
    add(trunc->hasNoUnsignedWrap(), "nuw");
    add(trunc->hasNoSignedWrap(), "nsw");
  }
  if (const auto *op = llvm::dyn_cast<llvm::PossiblyExactOperator>(&I))
    add(op->isExact(), "exact");
  if (const auto *op = llvm::dyn_cast<llvm::PossiblyNonNegInst>(&I))
    add(op->hasNonNeg(), "nneg");
  if (const auto *op = llvm::dyn_cast<llvm::PossiblyDisjointInst>(&I))
    add(op->isDisjoint(), "disjoint");
  if (const auto *cmp = llvm::dyn_cast<llvm::ICmpInst>(&I))
    add(cmp->hasSameSign(), "samesign");
  if (const auto *fp = llvm::dyn_cast<llvm::FPMathOperator>(&I)) {
    llvm::FastMathFlags fmf = fp->getFastMathFlags();
    add(fmf.allowReassoc(), "reassoc");
    add(fmf.noNaNs(), "nnan");
    add(fmf.noInfs(), "ninf");
    add(fmf.noSignedZeros(), "nsz");
    add(fmf.allowReciprocal(), "arcp");
    add(fmf.allowContract(), "contract");
    add(fmf.approxFunc(), "afn");
  }
  return flags;
}

} // namespace

llvm::json::Object numberCmd(llvm::json::Object &args) {
  CmdShape shape;
  llvm::json::Object err;
  if (!parseCmdShape(args, "number", shape, err))
    return err;

  // The same instructions as data, each at the index that names it.
  llvm::ModuleSlotTracker mst(shape.M);
  mst.incorporateFunction(*shape.F);
  // Outside the function, so that its name is `_` whatever the function names.
  std::unique_ptr<llvm::BasicBlock> anywhere(llvm::BasicBlock::Create(shape.M->getContext(), "_"));
  std::vector<llvm::json::Value> body(shape.F->getInstructionCount(), nullptr);
  for (auto &I : llvm::instructions(*shape.F)) {
    std::string type;
    llvm::raw_string_ostream os(type);
    I.getType()->print(os);
    llvm::json::Array operands;
    for (const llvm::Use &U : I.operands())
      operands.push_back(shape.refs->print(*U.get()));
    llvm::json::Object entry{{"block", shape.refs->print(*I.getParent())},
                             {"text", lineOf(I, mst)},
                             {"opcode", I.getOpcodeName()},
                             {"type", std::move(type)},
                             {"flags", flagsOf(I)},
                             {"operands", std::move(operands)},
                             {"commutative", I.isCommutative()},
                             {"form", formOf(I, *anywhere, mst)},
                             {"phi", llvm::isa<llvm::PHINode>(I)}};
    if (!I.getType()->isVoidTy())
      entry["value"] = shape.refs->print(I);
    if (const auto *phi = llvm::dyn_cast<llvm::PHINode>(&I)) {
      llvm::json::Array blocks;
      for (const llvm::BasicBlock *block : phi->blocks())
        blocks.push_back(shape.refs->print(*block));
      entry["blocks"] = std::move(blocks);
    }
    if (const auto *call = llvm::dyn_cast<llvm::CallBase>(&I)) {
      if (const llvm::Function *fn = call->getCalledFunction())
        entry["calls"] = "@" + fn->getName().str();
      llvm::json::Array arguments;
      for (const llvm::Use &arg : call->args())
        arguments.push_back(shape.refs->print(*arg.get()));
      entry["args"] = std::move(arguments);
      entry["pointer_args"] = llvm::any_of(
          call->args(), [](const llvm::Use &arg) { return holdsPointer(arg->getType()); });
    }
    body[*shape.refs->indexOf(I)] = std::move(entry);
  }

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["module"] = printNumbered(*shape.M, *shape.refs);
  resp["body"] = llvm::json::Array(std::move(body));
  return resp;
}

} // namespace llops
