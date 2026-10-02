#include "opt.h"

#include "irutil.h"

#include "llvm/Analysis/InstructionSimplify.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/PassInstrumentation.h"
#include "llvm/MC/TargetRegistry.h"
#include "llvm/Passes/PassBuilder.h"
#include "llvm/Support/DebugCounter.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/TargetSelect.h"
#include "llvm/Target/TargetMachine.h"
#include "llvm/Transforms/InstCombine/InstCombine.h"

#include <limits>
#include <string>

namespace llops {

namespace {

// The analysis managers a pass runs with, registered and linked to each
// other. They are declared in this order so that each outlives those that
// refer to it.
struct Analyses {
  llvm::LoopAnalysisManager LAM;
  llvm::FunctionAnalysisManager FAM;
  llvm::CGSCCAnalysisManager CGAM;
  llvm::ModuleAnalysisManager MAM;

  explicit Analyses(llvm::PassBuilder &PB) {
    PB.registerModuleAnalyses(MAM);
    PB.registerCGSCCAnalyses(CGAM);
    PB.registerFunctionAnalyses(FAM);
    PB.registerLoopAnalyses(LAM);
    PB.crossRegisterProxies(LAM, FAM, CGAM, MAM);
  }
};

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
  if (inst->isTerminator())
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
      created->insertInto(inst->getParent(), inst->getIterator());

  inst->replaceAllUsesWith(result);
  inst->eraseFromParent();
  return checkedResponse(*shape.M);
}

llvm::json::Object instcombine(llvm::json::Object &args, CmdShape &shape) {
  unsigned maxIterations = llvm::InstCombineDefaultMaxIterations;
  if (auto *value = args.get("max_iterations")) {
    auto parsed = value->getAsInteger();
    if (!parsed || *parsed <= 0 ||
        static_cast<uint64_t>(*parsed) > std::numeric_limits<unsigned>::max())
      return errResponse("bad_request",
                         "opt instcombine: 'max_iterations' must be a positive integer");
    maxIterations = static_cast<unsigned>(*parsed);
  }

  if (auto *value = args.get("debug_counter")) {
    auto parsed = value->getAsInteger();
    if (!parsed || *parsed < 0)
      return errResponse("bad_request",
                         "opt instcombine: 'debug_counter' must be a non-negative integer");

    // InstCombine consults this counter immediately before visiting an
    // instruction. A single-number chunk executes only that zero-based visit,
    // which keeps the requested transformation as small as LLVM exposes it.
    auto &counters = llvm::DebugCounter::instance();
    if (!counters.getCounterInfo("instcombine-visit"))
      return errResponse("internal", "opt instcombine: LLVM did not register its visit counter");
    counters.push_back("instcombine-visit=" + std::to_string(*parsed));
  }

  llvm::PassBuilder PB;
  Analyses analyses(PB);
  llvm::InstCombineOptions options;
  options.setMaxIterations(maxIterations);
  llvm::FunctionPassManager FPM;
  FPM.addPass(llvm::InstCombinePass(options));
  FPM.run(*shape.F, analyses.FAM);

  return checkedResponse(*shape.M);
}

// The machine the module's triple names, made as opt makes it, so that passes
// with a cost model, such as the vectorizers, decide as opt does for that
// target. Like opt, a pipeline runs without one when there is none to make.
std::unique_ptr<llvm::TargetMachine> machineFor(const llvm::Module &M) {
  llvm::InitializeAllTargetInfos();
  llvm::InitializeAllTargets();
  llvm::InitializeAllTargetMCs();
  std::string error;
  const llvm::Triple &triple = M.getTargetTriple();
  const llvm::Target *target = llvm::TargetRegistry::lookupTarget(triple, error);
  if (!target)
    return nullptr;
  return std::unique_ptr<llvm::TargetMachine>(
      target->createTargetMachine(triple, "", "", llvm::TargetOptions(), std::nullopt));
}

// Run a pipeline and keep the module after each pass that changed it. A pass
// manager runs passes rather than being one, so it is never a stage.
llvm::json::Object pipeline(llvm::json::Object &args, CmdShape &shape) {
  if (args.get("passes") && !args.getString("passes"))
    return errResponse("bad_request", "opt pipeline: 'passes' must be a string");
  llvm::StringRef passes = args.getString("passes").value_or("default<O3>");

  llvm::PassInstrumentationCallbacks PIC;
  std::unique_ptr<llvm::TargetMachine> machine = machineFor(*shape.M);
  llvm::PassBuilder PB(machine.get(), llvm::PipelineTuningOptions(), std::nullopt, &PIC);
  Analyses analyses(PB);
  llvm::ModulePassManager MPM;
  if (auto error = PB.parsePassPipeline(MPM, passes))
    return errResponse("bad_request", "opt pipeline: " + llvm::toString(std::move(error)));

  llvm::json::Array stages;
  std::string last = printModule(*shape.M);
  auto record = [&](llvm::StringRef pass) {
    if (llvm::isSpecialPass(pass, {"PassManager", "PassAdaptor", "AnalysisManagerProxy",
                                   "DevirtSCCRepeatedPass", "ModuleInlinerWrapperPass"}))
      return;
    std::string now = printModule(*shape.M);
    if (now == last)
      return;
    // A copy, since a JSON string made from a StringRef only points at the
    // name, which the callbacks own and drop before the response is printed.
    llvm::StringRef name = PIC.getPassNameForClassName(pass);
    std::string named = (name.empty() ? pass : name).str();
    stages.push_back(llvm::json::Object{{"pass", std::move(named)}, {"module", now}});
    last = std::move(now);
  };
  PIC.registerAfterPassCallback(
      [&](llvm::StringRef pass, llvm::Any, const llvm::PreservedAnalyses &) { record(pass); });
  PIC.registerAfterPassInvalidatedCallback(
      [&](llvm::StringRef pass, const llvm::PreservedAnalyses &) { record(pass); });
  MPM.run(*shape.M, analyses.MAM);

  return llvm::json::Object{{"ok", true}, {"stages", std::move(stages)}};
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
  if (*what == "instcombine")
    return instcombine(args, shape);
  if (*what == "pipeline")
    return pipeline(args, shape);

  return errResponse("bad_request", "unknown opt op '" + what->str() + "'");
}

} // namespace llops
