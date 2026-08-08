// `validate`: parse a module and report the straightline v1 invariants. The
// diagnostic codes are in docs/llops.md; a response is ok when the module
// parses, whether or not it conforms.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object validateCmd(llvm::json::Object &args);

} // namespace llops
