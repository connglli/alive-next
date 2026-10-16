// The `analyze` subcommand.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Run an LLVM analysis at a program point and report facts as JSON shaped for
// attributes and assumes.
//
// Analyses are untrusted proposers: a fact enters a certificate only through a
// step alive2 proves, so a wrong fact costs time and cannot cost soundness. The
// analysis point doubles as the assumption context, which is what makes an
// llvm.assume earlier in the body count.
llvm::json::Object analyzeCmd(llvm::json::Object &args);

} // namespace llops
