// alive-tv-next: per-unit alive2 dispatch.
//
// Modeled on llvm_util::compare.cpp's `verify(F1, F2, ...)` helper:
//   1. llvm2alive each function → IR::Function
//   2. Build a tools::Transform from the pair
//   3. preprocess + TransformVerify::verify
//   4. Translate alive2's util::Errors into a UnitVerdict
//
// We don't go through llvm_util::Verifier::compareFunctions because (a) it
// prints to a stream we don't want cluttered per-unit, and (b) Phase 3 needs
// to inject preconditions into the Transform — direct API access is the
// right path.
//
// Phase 3: when a unit returns Unsound or FailedToProve and parent context
// is supplied, the verifier consults `proposeAssume` for a hand-coded
// assume proposer. If a proposer fires, it produces a *modified unit*
// (with `llvm.assume(precondition)` injected) and a *standalone
// assume-check* (proves the precondition holds in the parent's input
// space). Both must verify; the proposer-augmented verdict then replaces
// the original.

#pragma once

#include "unit.h"

#include "llvm/Analysis/TargetLibraryInfo.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Module.h"

#include "smt/smt.h"

#include <functional>
#include <string>

namespace alive_tv_next {

struct UnitVerdict {
  std::string name; // unit identifier (e.g., "unit@v3")
  bool passed = false;
  std::string error_message; // populated on fail / fail-to-prove / error
  std::string proposer_name; // populated when a proposer was used
  enum class Status {
    Correct,
    Unsound,
    FailedToProve,
    TypeCheckerFailed,
    Error,
    SyntacticallyEqual,
  } status = Status::Error;
};

// Callback invoked after each TvUnit (original, assume-check, modified) is
// verified. Lets callers render verdicts as they happen, including derivative
// units the proposer generates internally. The callback sees the same TvUnit
// instance the verifier just ran on; do not retain references past the call.
using UnitProgressFn = std::function<void(const TvUnit &, const UnitVerdict &)>;

// Run alive2 on a single TvUnit. `tli` and `smt_init` must already be
// initialized by the caller (typically once in main).
//
// `parent_src` and `parent_tgt` are optional: when both are non-null, failed
// verdicts (Unsound / FailedToProve) trigger the assume-proposer retry path.
// They should be the @src and @tgt parent functions that the TvUnit was
// lifted from. The proposer uses both: each is the anchor for one side's
// range analysis and one of the standalone soundness checks (chain
// refinement bridges between them).
// `dump_dir`, when non-empty, writes the original TvUnit and any proposer-
// generated units (modified unit + assume-check) to `<dump_dir>/<name>.ll`.
// `context_header`, when non-empty, is prepended verbatim to each dumped
// file — typically a `; `-prefixed comment block produced by the caller that
// locates the unit inside its parent functions.
// `progress`, when set, is invoked after each runOnce — once for the
// original unit, once per assume-check, and once for the modified unit (when
// the proposer fires).
UnitVerdict verifyTvUnit(TvUnit &unit, llvm::TargetLibraryInfoWrapperPass &tli,
                         smt::smt_initializer &smt_init,
                         llvm::Function *parent_src = nullptr,
                         llvm::Function *parent_tgt = nullptr,
                         const std::string &dump_dir = "",
                         const std::string &context_header = "",
                         const UnitProgressFn &progress = {});

} // namespace alive_tv_next
