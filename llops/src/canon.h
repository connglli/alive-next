// `canon`: parse, renumber every local value, print. The certificate checker
// compares programs as bytes, so this is what makes "identical up to names"
// decidable by string comparison.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Request: { "module": "<ir text>" }
// Response: { "ok": true, "module": "<canonical text>" }
llvm::json::Object canonCmd(llvm::json::Object &args);

} // namespace llops
