// `instantiate`: put a counterexample's input into both programs of a pair, as
// assumptions at the entry. The request is in docs/llops.md.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object instantiateCmd(llvm::json::Object &args);

} // namespace llops
