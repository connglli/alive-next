// The `validate` subcommand.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Parse a module and report how it departs from the program shape. A response
// is ok when the module parses, whether or not it conforms.
llvm::json::Object validateCmd(llvm::json::Object &args);

} // namespace llops
