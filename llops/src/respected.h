// `respected`: whether one function is another with attributes added that its
// own instructions cannot break, so that it refines the other with no solver.
//
// alive2 checks memory(...), nofree, readonly, writeonly, readnone and
// captures(none) only against a function's own instructions, and when those
// cannot break them, the function runs the same with them as without. See
// docs/llops.md for the rules, the request and the response.
#pragma once

#include "llvm/IR/Function.h"
#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object respectedCmd(llvm::json::Object &args);

// Remove the attributes `respected` checks, as the `drop_attrs` edit does.
void dropCheckedAttrs(llvm::Function &F);

} // namespace llops
