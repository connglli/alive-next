// `detach` and `reattach`: a block and everything it reaches leave the function
// as a function of their own, and come back.
//
// detach moves block B and every block it reaches into a fresh function `k`,
// whose parameters are B's phis followed by the values those blocks use from
// outside, so `k` runs the rest of the program from B. Every edge into B
// becomes an edge into a fresh block that calls `k` and returns what it
// answers. An edge from inside, which exists when B heads a loop, calls
// `k.ih` instead: a declaration with `k`'s signature that stands for `k`
// within its own body. The body is then loop-free, and a proof about `k` may
// treat that call as the induction hypothesis.
//
// reattach removes those blocks, sends their predecessors to the callee's
// entry, and turns the parameters back into phis there. See docs/llops.md for
// the request and response.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object detachCmd(llvm::json::Object &args);

llvm::json::Object reattachCmd(llvm::json::Object &args);

} // namespace llops
