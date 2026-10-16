// The `opt` subcommand.
#pragma once

#include "llvm/IR/Module.h"
#include "llvm/Support/JSON.h"

namespace llops {

// Run structural optimizer passes over the body. Each op is LLVM's own
// machinery, so a simplification is the same algebra alive2 reasons about
// rather than a second set of rules that could drift. They are still
// proposals: the agent certifies the result with alive2 like any other edit.
llvm::json::Object optCmd(llvm::json::Object &args);

} // namespace llops
