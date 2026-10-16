// The `instantiate` subcommand.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Put a counterexample's input into both programs of a pair, as assumptions at
// the entry.
llvm::json::Object instantiateCmd(llvm::json::Object &args);

} // namespace llops
