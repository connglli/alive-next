// `reshaped`: whether one function is another with its control flow reshaped
// and nothing else, so that every run of it is a run of the other, step for
// step, and a step between them needs no solver.
//
// Rotating a loop, merging or splitting blocks, dropping an empty one, adding
// an LCSSA phi or inverting a branch changes what the function looks like but
// not what any run of it does. The check walks both functions together, one
// segment at a time: a segment runs from where a block is entered up to a
// conditional branch, a switch or a return, through every unconditional
// branch on the way. Paired segments must apply the same instructions to
// operands that hold the same values and end the same way: on conditions that
// hold the same value, or on a comparison with the inverse predicate that
// nothing but the branch uses, with the successors swapped. Metadata counts as
// alive2 reads it, so the answer holds under alive2's semantics.
//
// Which values of `after` hold the same value as which values of `before` is
// tracked per pair of entering edges, as what holds on every path there: the
// walk intersects until nothing changes, which settles loops. Each run of
// `after` is then a run of `before` with the same instructions on the same
// values, so it has the same behavior, undefined behavior included. The rest
// of the two modules must be the same. See docs/llops.md for the request and
// response.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object reshapedCmd(llvm::json::Object &args);

} // namespace llops
