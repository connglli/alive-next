#include "number.h"

#include "irutil.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/ModuleSlotTracker.h"
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

} // namespace

llvm::json::Object numberCmd(llvm::json::Object &args) {
  CmdShape shape;
  llvm::json::Object err;
  if (!parseCmdShape(args, "number", shape, err))
    return err;

  // The same instructions as data, each at the index that names it.
  llvm::ModuleSlotTracker mst(shape.M);
  mst.incorporateFunction(*shape.F);
  std::vector<llvm::json::Value> body(shape.F->getInstructionCount(), nullptr);
  for (auto &I : llvm::instructions(*shape.F)) {
    llvm::json::Object entry{{"block", shape.refs->print(*I.getParent())},
                             {"text", lineOf(I, mst)},
                             {"phi", llvm::isa<llvm::PHINode>(I)}};
    if (!I.getType()->isVoidTy())
      entry["value"] = shape.refs->print(I);
    body[*shape.refs->indexOf(I)] = std::move(entry);
  }

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["module"] = printNumbered(*shape.M, *shape.refs);
  resp["body"] = llvm::json::Array(std::move(body));
  return resp;
}

} // namespace llops
