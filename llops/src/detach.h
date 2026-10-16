// The `detach`, `reattach` and `unfold` subcommands: a block and everything it
// reaches leave the function as a function of their own, and come back.
#pragma once

#include "irutil.h"

#include "llvm/IR/Module.h"
#include "llvm/Support/JSON.h"

namespace llops {

// Move block B and every block it reaches into a fresh function `k`, whose
// parameters are B's phis followed by the values those blocks use from outside,
// so `k` runs the rest of the program from B. Every edge into B becomes an edge
// into a fresh block that calls `k` and returns what it answers. An edge from
// inside, which exists when B heads a loop, calls `k.ih` instead: a declaration
// with `k`'s signature that stands for `k` within its own body. The body is
// then loop-free, and a proof about `k` may treat that call as the induction
// hypothesis.
llvm::json::Object detachCmd(llvm::json::Object &args);

// Remove the blocks `detach` made, send their predecessors to the callee's
// entry, and turn the parameters back into phis there.
llvm::json::Object reattachCmd(llvm::json::Object &args);

// Put the callee's body at each call of its hypothesis, so that one call runs
// two iterations, or at each call of the callee in the outer, so that the outer
// runs the first iteration.
llvm::json::Object unfoldCmd(llvm::json::Object &args);

// What `outline` answers for a cut at an instruction.
llvm::json::Object outlineRest(llvm::json::Object &args, llvm::Module &M, llvm::Function &F,
                               ValueRefs &refs, llvm::Instruction *cut, llvm::StringRef name);

} // namespace llops
