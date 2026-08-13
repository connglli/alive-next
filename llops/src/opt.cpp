#include "opt.h"

#include "irutil.h"

#include "llvm/Analysis/InstructionSimplify.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Module.h"
#include "llvm/Support/JSON.h"

namespace llops {

namespace {

// Fold one instruction with LLVM's own simplifier. The uses are rewritten to
// the simplified value and the instruction goes away; nothing else in the
// body moves, so the step stays as small as it was asked to be, and an
// instruction with nothing to fold comes back unchanged.
llvm::json::Object simplify(llvm::json::Object &args, CmdShape &shape) {
  auto v = args.getString("v");
  if (!v)
    return errResponse("bad_request", "opt simplify needs 'v'");
  llvm::Instruction *inst = shape.refs->resolveInst(*v);
  if (!inst)
    return errResponse("not_found", "opt simplify: unknown instruction");
  if (inst == shape.BB->getTerminator())
    return errResponse("invalid", "opt simplify: the terminator cannot be simplified");

  llvm::SimplifyQuery Q(shape.M->getDataLayout());
  llvm::Value *result = llvm::simplifyInstruction(inst, Q);
  if (!result)
    return moduleResponse(*shape.M);
  if (result->getType() != inst->getType())
    return errResponse("internal", "opt simplify: the simplifier changed the instruction's type");

  // A fold may compute a fresh instruction: it has to sit where the old one
  // was, which its operands, being the old instruction's own, all dominate.
  if (auto *created = llvm::dyn_cast<llvm::Instruction>(result))
    if (!created->getParent())
      created->insertInto(shape.BB, inst->getIterator());

  inst->replaceAllUsesWith(result);
  inst->eraseFromParent();
  return checkedResponse(*shape.F, *shape.M);
}

} // namespace

llvm::json::Object optCmd(llvm::json::Object &args) {
  auto what = args.getString("what");
  if (!what)
    return errResponse("bad_request", "opt needs 'what'");

  CmdShape shape;
  llvm::json::Object err;
  if (!parseCmdShape(args, "opt", shape, err))
    return err;

  if (*what == "simplify")
    return simplify(args, shape);

  return errResponse("bad_request", "unknown opt op '" + what->str() + "'");
}

} // namespace llops
