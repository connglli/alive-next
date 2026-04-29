// alive-tv-next — alive-next compositional translation validator.
//
// This is the M1.1 stub: CMake target + main() scaffolding modeled on
// tools/alive-tv.cpp. It compiles, links against the same alive2 + LLVM
// libraries alive-tv uses, initializes LLVM and the Alive2 SMT layer, and
// prints a "not implemented" notice. Subsequent milestones (M1.2+, see
// ../PLAN.md) wire in IR loading, diff / cut, per-cut verify, and compose.
//
// TODO(M1.2+): include `llvm_util/cmd_args_list.h` the way tools/alive-tv.cpp
// does (with LLVM_ARGS_PREFIX / ARGS_SRC_TGT / ARGS_REFINEMENT) so we inherit
// alive-tv's full flag surface (--smt-to, --disable-undef-input, --src-fn,
// --tgt-fn, the LLVM init flags, etc.) without duplication. Held off in M1.1
// to keep the stub minimal.

#include "smt/smt.h"
#include "util/version.h"

#include "llvm/InitializePasses.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/Support/CommandLine.h"
#include "llvm/Support/InitLLVM.h"
#include "llvm/Support/Signals.h"

#include <iostream>
#include <string>

namespace {

llvm::cl::OptionCategory alive_tv_next_cmdargs("alive-tv-next options");

llvm::cl::opt<std::string> opt_file1(
    llvm::cl::Positional, llvm::cl::desc("first_bitcode_file"),
    llvm::cl::Optional, llvm::cl::value_desc("filename"),
    llvm::cl::cat(alive_tv_next_cmdargs));

llvm::cl::opt<std::string> opt_file2(
    llvm::cl::Positional, llvm::cl::desc("[second_bitcode_file]"),
    llvm::cl::Optional, llvm::cl::value_desc("filename"),
    llvm::cl::cat(alive_tv_next_cmdargs));

// LLM-mode (later phases). The model name is per-invocation (CLI flag);
// the API key and endpoint are deployment-fixed (env vars
// ALIVE_NEXT_LLM_API_KEY, ALIVE_NEXT_LLM_BASE_URL — read lazily when the
// LLM proposer is invoked).
llvm::cl::opt<std::string> opt_model(
    "model",
    llvm::cl::desc("LLM model name for cut/assume proposers. Without it, "
                   "the pilot uses only the bundled catalog and hand-coded "
                   "proposers."),
    llvm::cl::cat(alive_tv_next_cmdargs), llvm::cl::init(""));

// Developer / debug flags (not documented for end users).
// TODO(M1.2+): wire these in as the corresponding mechanisms land.
//   --no-catalog              skip catalog matching
//   --no-llm                  force-disable LLM proposer
//   --catalog-override DIR    test alternate catalogs
//   --whole-function-recheck  paranoid alive2 re-run after composition
//   --dump-cuts DIR           serialize cuts for inspection

} // namespace

int main(int argc, char **argv) {
  llvm::sys::PrintStackTraceOnErrorSignal(argv[0]);
  llvm::InitLLVM X(argc, argv);
  llvm::EnableDebugBuffering = true;

  std::string usage =
      "alive-tv-next — alive-next compositional translation validator\n"
      "version: ";
  usage += util::alive_version;
  usage +=
      "\n\n"
      "Usage:\n"
      "  alive-tv-next [alive-tv flags...] pre.ll [post.ll]\n"
      "  alive-tv-next [alive-tv flags...] combined.srctgt.ll\n"
      "\n"
      "  --model MODEL           LLM model for cut/assume proposers (later\n"
      "                          phases). Auth via ALIVE_NEXT_LLM_API_KEY\n"
      "                          env var; endpoint via ALIVE_NEXT_LLM_BASE_URL.\n"
      "\n"
      "Input is a raw slice; assumes (when needed) are derived internally\n"
      "by hand-coded proposers (Phase 3) or the LLM (later phases) and\n"
      "injected as `llvm.assume` into per-cut alive2 queries.\n"
      "\n"
      "The catalog of pre-verified rewrites is bundled with the binary; no\n"
      "user-facing catalog flag.\n"
      "\n"
      "STATUS: WIP, M1.1 stub. Build infrastructure works; the verification\n"
      "pipeline (diff / cut / per-cut alive2 / compose) lands in M1.2 onward.\n"
      "See alive-next/PLAN.md for the staged plan and alive-next/IDEA.md for\n"
      "the design rationale.\n";

  llvm::cl::HideUnrelatedOptions(alive_tv_next_cmdargs);
  llvm::cl::ParseCommandLineOptions(argc, argv, usage);

  // Initialize the SMT layer. Confirms the link against alive2's smt library
  // is correctly wired; later milestones use this for per-cut verification.
  smt::smt_initializer smt_init;

  std::cout << "alive-tv-next " << util::alive_version << " (M1.1 stub)\n";
  if (!opt_file1.empty())
    std::cout << "  file1: " << opt_file1 << "\n";
  if (!opt_file2.empty())
    std::cout << "  file2: " << opt_file2 << "\n";
  if (!opt_model.empty())
    std::cout << "  model: " << opt_model << "\n";
  std::cout << "\n";
  std::cout << "Pipeline not yet implemented. Returning 0 to indicate a clean\n"
               "build / launch; this is not a verification verdict.\n";

  return 0;
}
