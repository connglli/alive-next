// alive-tv-next: per-cut alive2 dispatch.
//
// Modeled on llvm_util::compare.cpp's `verify(F1, F2, ...)` helper:
//   1. llvm2alive each function → IR::Function
//   2. Build a tools::Transform from the pair
//   3. preprocess + TransformVerify::verify
//   4. Translate alive2's util::Errors into a CutVerdict
//
// We don't go through llvm_util::Verifier::compareFunctions because (a) it
// prints to a stream we don't want cluttered per-cut, and (b) Phase 3 needs
// to inject preconditions into the Transform — direct API access is the
// right path.
//
// Phase 3: when a cut returns Unsound or FailedToProve and parent context
// is supplied, the verifier consults `proposeAssume` for a hand-coded
// assume proposer. If a proposer fires, it produces a *modified cut*
// (with `llvm.assume(precondition)` injected) and a *standalone
// assume-check* (proves the precondition holds in the parent's input
// space). Both must verify; the proposer-augmented verdict then replaces
// the original.

#pragma once

#include "cut.h"

#include "llvm/Analysis/TargetLibraryInfo.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Module.h"

#include "smt/smt.h"

#include <string>

namespace alive_tv_next {

struct CutVerdict {
  std::string name;            // cut identifier (e.g., "cut@v3")
  bool passed = false;
  std::string error_message;   // populated on fail / fail-to-prove / error
  std::string proposer_name;   // populated when a proposer was used
  enum class Status {
    Correct,
    Unsound,
    FailedToProve,
    TypeCheckerFailed,
    Error,
    SyntacticallyEqual,
  } status = Status::Error;
};

// Run alive2 on a single cut. `tli` and `smt_init` must already be
// initialized by the caller (typically once in main).
//
// `parent_src` and `parent_module` are optional: when both are non-null,
// failed verdicts (Unsound / FailedToProve) trigger the assume-proposer
// retry path. They should be the @src function and module that the cut
// was lifted from, so the proposer can trace the cut's parameters back
// to their parent definitions (e.g., to recognize "operands are sext from
// i32").
// `dump_dir`, when non-empty, writes the original cut and any proposer-
// generated cuts (modified cut + assume-check) to
// `<dump_dir>/<name>.srctgt.ll`. Caller is responsible for writing the
// original cut; this path covers proposer-internal cuts.
CutVerdict verifyCut(Cut &cut, llvm::TargetLibraryInfoWrapperPass &tli,
                     smt::smt_initializer &smt_init,
                     llvm::Function *parent_src = nullptr,
                     llvm::Module *parent_module = nullptr,
                     const std::string &dump_dir = "");

}  // namespace alive_tv_next
