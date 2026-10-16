// The `poison` subcommand.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Make one parameter of a function poison. A proof by cases uses the result as
// its case for the inputs that pass poison to that parameter.
llvm::json::Object poisonCmd(llvm::json::Object &args);

} // namespace llops
