// alive-tv-next — alive-next compositional translation validator.
//
// Entry point: load a paired @src/@tgt slice, compute a per-line structural
// diff, build a Transform for each diff group, run alive2 on each, and
// aggregate. Modeled on tools/alive-tv.cpp (same alive2 init pattern, same
// flag inheritance via cmd_args_list.h).
//
// LATER (M3+): hook in catalog matching, hand-coded assume proposers,
// LLM-driven proposers (--model). For now the path is purely
// diff → cut → per-cut alive2 → compose.

#include "tv-next/compose.h"
#include "tv-next/cut.h"
#include "tv-next/diff.h"
#include "tv-next/ir_load.h"
#include "tv-next/verify.h"

#include "cache/cache.h"
#include "llvm_util/llvm2alive.h"
#include "llvm_util/utils.h"
#include "smt/smt.h"
#include "smt/solver.h"
#include "tools/transform.h"
#include "util/version.h"

#include "llvm/Analysis/TargetLibraryInfo.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/InitializePasses.h"
#include "llvm/Support/CommandLine.h"
#include "llvm/Support/FileSystem.h"
#include "llvm/Support/InitLLVM.h"
#include "llvm/Support/Signals.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/TargetParser/Triple.h"

#include <cctype>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

using namespace std;
using namespace tools;
using namespace util;

// Inherit alive-tv's full flag surface (--smt-to, --disable-undef-input,
// --disable-poison-input, the LLVM init flags, etc.) by including the same
// header tools/alive-tv.cpp does. Provides `alive_cmdargs` (OptionCategory),
// `out_file` (ofstream), `out` (ostream*), `func_names`, and a long list of
// `opt_*` cl::opts. cmd_args_def.h (included from main, after cli parse +
// module load) wires those opts into util::config / smt:: globals and
// initializes `out` / report-dir / output-file machinery.
#define LLVM_ARGS_PREFIX ""
#define ARGS_SRC_TGT
#define ARGS_REFINEMENT
#include "llvm_util/cmd_args_list.h"

namespace {

llvm::cl::opt<std::string> opt_file1(
    llvm::cl::Positional, llvm::cl::desc("first_bitcode_file"),
    llvm::cl::Required, llvm::cl::value_desc("filename"),
    llvm::cl::cat(alive_cmdargs));

llvm::cl::opt<std::string> opt_file2(
    llvm::cl::Positional, llvm::cl::desc("[second_bitcode_file]"),
    llvm::cl::Optional, llvm::cl::value_desc("filename"),
    llvm::cl::cat(alive_cmdargs));

llvm::cl::opt<std::string> opt_src_fn(
    LLVM_ARGS_PREFIX "src-fn",
    llvm::cl::desc("Name of src function (without @)"),
    llvm::cl::cat(alive_cmdargs), llvm::cl::init("src"));

llvm::cl::opt<std::string> opt_tgt_fn(
    LLVM_ARGS_PREFIX "tgt-fn",
    llvm::cl::desc("Name of tgt function (without @)"),
    llvm::cl::cat(alive_cmdargs), llvm::cl::init("tgt"));

// LLM-mode (later phases). Per-invocation choice → CLI flag. API key /
// endpoint are deployment-fixed and live in env vars
// (ALIVE_NEXT_LLM_API_KEY, ALIVE_NEXT_LLM_BASE_URL); read lazily when the
// LLM proposer is invoked.
llvm::cl::opt<std::string> opt_model(
    LLVM_ARGS_PREFIX "model",
    llvm::cl::desc("LLM model name for cut/assume proposers (later phases). "
                   "Without it, alive-tv-next uses only the bundled catalog "
                   "and hand-coded proposers."),
    llvm::cl::cat(alive_cmdargs), llvm::cl::init(""));

llvm::cl::opt<bool> opt_alive_tv_next_verbose(
    LLVM_ARGS_PREFIX "tv-verbose",
    llvm::cl::desc("Print per-cut verdicts and diff summary"),
    llvm::cl::cat(alive_cmdargs), llvm::cl::init(false));

llvm::cl::opt<std::string> opt_dump_cuts(
    LLVM_ARGS_PREFIX "dump-cuts",
    llvm::cl::desc("Write each generated cut to <DIR>/<name>.srctgt.ll for "
                   "inspection. Developer/debug flag."),
    llvm::cl::cat(alive_cmdargs), llvm::cl::init(""));

// Sanitize a diagnostic name into a filesystem-safe filename stem:
// replace anything outside [A-Za-z0-9._-] with '_'.
std::string sanitizeName(std::string s) {
  for (char &c : s) {
    if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '.' ||
          c == '_' || c == '-'))
      c = '_';
  }
  return s;
}

}  // namespace

// Required by cmd_args_def.h's `cache = make_unique<Cache>(...)` branch.
// Even with NO_REDIS_SUPPORT the symbol is referenced (the -cache opt
// path errors out at runtime), so it must be in scope.
unique_ptr<Cache> cache;

int main(int argc, char **argv) {
  llvm::sys::PrintStackTraceOnErrorSignal(argv[0]);
  llvm::InitLLVM X(argc, argv);
  llvm::EnableDebugBuffering = true;
  llvm::LLVMContext Context;

  std::string usage =
      "alive-tv-next — alive-next compositional translation validator\n"
      "version: ";
  usage += util::alive_version;
  usage += R"EOF(

Usage:
  alive-tv-next [alive-tv flags...] pre.ll [post.ll]
  alive-tv-next [alive-tv flags...] combined.srctgt.ll

Input is a raw slice (@src and @tgt), either as two files or one file
containing both functions. Assumes (when needed for Phase 3+ rewrites)
are derived internally and injected as `llvm.assume` into per-cut alive2
queries.

The catalog of pre-verified rewrites is bundled with the binary; no
user-facing catalog flag.

LLM fallback (later phases) is opt-in via --model; auth via
ALIVE_NEXT_LLM_API_KEY env var, endpoint via ALIVE_NEXT_LLM_BASE_URL.
)EOF";

  llvm::cl::HideUnrelatedOptions(alive_cmdargs);
  llvm::cl::ParseCommandLineOptions(argc, argv, usage);

  // Load the slice.
  auto loaded = alive_tv_next::loadSlice(opt_file1, opt_file2, opt_src_fn,
                                         opt_tgt_fn, Context);
  if (!loaded) {
    return 1;
  }

  // Wire alive-tv's command-line options into util::config / smt:: globals
  // and set up `out` / report-dir / output-file machinery. Same pattern as
  // tools/alive-tv.cpp (line 126-127). Must come after CLI parse + module
  // load and before any code that consults config:: or *out.
#define ARGS_MODULE_VAR loaded->module1
#include "llvm_util/cmd_args_def.h"

  // Initialize alive2 globals once with the input module's data layout.
  auto &DL = loaded->module1->getDataLayout();
  llvm::Triple targetTriple(loaded->module1->getTargetTriple());
  llvm::TargetLibraryInfoWrapperPass TLI(targetTriple);
  llvm_util::initializer llvm_util_init(*out, DL);
  smt::smt_initializer smt_init;

  // Compute the diff. Diff positions are grouped into runs of consecutive
  // diffs (Phase 2): each run is lifted as one Transform.
  auto diff = alive_tv_next::computeDiff(*loaded->src_fn, *loaded->tgt_fn);
  if (!diff) {
    return 1;
  }
  if (opt_alive_tv_next_verbose) {
    size_t total_diffs = 0, multi_side_groups = 0;
    for (const auto &g : diff->groups) {
      if (g.is_multi_side) ++multi_side_groups;
      else total_diffs += g.positions.size();
    }
    *out << "alive-tv-next: " << diff->identical_count
         << " identical position(s), " << total_diffs
         << " diff position(s) across " << diff->groups.size()
         << " group(s)";
    if (multi_side_groups)
      *out << " (" << multi_side_groups << " multi-side)";
    *out << "\n";
  }

  // Build and verify each group as a single Transform.
  std::vector<alive_tv_next::CutVerdict> verdicts;
  verdicts.reserve(diff->groups.size());

  for (const alive_tv_next::DiffGroup &group : diff->groups) {
    // Diagnostic name.
    std::string diag_name;
    if (group.is_multi_side) {
      diag_name = "cut@src-i" + std::to_string(group.src_start_idx);
      if (!group.src_region.empty())
        diag_name += "..i" + std::to_string(group.src_start_idx +
                                             group.src_region.size() - 1);
      diag_name += "/tgt-i" + std::to_string(group.tgt_start_idx);
      if (!group.tgt_region.empty())
        diag_name += "..i" + std::to_string(group.tgt_start_idx +
                                             group.tgt_region.size() - 1);
    } else if (group.positions.size() == 1) {
      diag_name = "cut@i" + std::to_string(group.positions.front().inst_idx);
      if (group.positions.front().src_inst->hasName())
        diag_name +=
            "(%" + group.positions.front().src_inst->getName().str() + ")";
    } else {
      diag_name =
          "cut@i" + std::to_string(group.positions.front().inst_idx) +
          "..i" + std::to_string(group.positions.back().inst_idx);
    }

    auto cut = alive_tv_next::buildGroupCut(group, *loaded->module1, Context,
                                            diag_name);
    if (!cut) {
      // Build failure: surface as a failed verdict so the slice fails cleanly.
      alive_tv_next::CutVerdict v;
      v.name = diag_name;
      v.passed = false;
      v.status = alive_tv_next::CutVerdict::Status::Error;
      v.error_message = "could not lift group into a Transform";
      verdicts.push_back(std::move(v));
      continue;
    }

    // --dump-cuts: write the lifted IR for inspection.
    if (!opt_dump_cuts.empty()) {
      std::error_code ec;
      std::string path = opt_dump_cuts + "/" + sanitizeName(diag_name) +
                         ".srctgt.ll";
      llvm::raw_fd_ostream dump_os(path, ec);
      if (ec) {
        llvm::errs() << "alive-tv-next: could not open " << path << " for "
                     << "dump: " << ec.message() << "\n";
      } else {
        cut->module->print(dump_os, /*AAW=*/nullptr);
      }
    }

    auto verdict = alive_tv_next::verifyCut(*cut, TLI, smt_init,
                                            loaded->src_fn,
                                            loaded->module1.get(),
                                            opt_dump_cuts);
    if (opt_alive_tv_next_verbose) {
      *out << "  " << verdict.name << ": "
           << (verdict.passed ? "pass" : "FAIL");
      if (!verdict.proposer_name.empty())
        *out << " (via " << verdict.proposer_name << ")";
      if (!verdict.passed && !verdict.error_message.empty())
        *out << " — " << verdict.error_message;
      *out << "\n";
    }
    verdicts.push_back(std::move(verdict));
  }

  // Aggregate.
  auto result = alive_tv_next::composeCuts(std::move(verdicts),
                                           diff->identical_count);

  if (result.passed) {
    *out << "Transformation seems to be correct!\n";
    return 0;
  }
  *out << "Transformation doesn't verify\n";
  if (!result.error_message.empty())
    *out << result.error_message;
  return 1;
}
