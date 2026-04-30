// alive-tv-next: per-cut alive2 dispatch.
//
// Modeled on llvm_util::compare.cpp's `verify(F1, F2, ...)` helper:
//   1. llvm2alive each function → IR::Function
//   2. Build a tools::Transform from the pair
//   3. preprocess + TransformVerify::verify
//   4. Translate alive2's util::Errors into a CutVerdict
//
// We don't go through llvm_util::Verifier::compareFunctions because (a) it
// prints to a stream we don't want cluttered per-cut, and (b) Phase 3 will
// need to inject preconditions into the Transform — direct API access is
// the right path.

#pragma once

#include "cut.h"

#include "llvm/Analysis/TargetLibraryInfo.h"

#include "smt/smt.h"

#include <string>

namespace alive_tv_next {

struct CutVerdict {
  std::string name;            // cut identifier (e.g., "cut@v3")
  bool passed = false;
  std::string error_message;   // populated on fail / fail-to-prove / error
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
CutVerdict verifyCut(Cut &cut, llvm::TargetLibraryInfoWrapperPass &tli,
                     smt::smt_initializer &smt_init);

}  // namespace alive_tv_next
