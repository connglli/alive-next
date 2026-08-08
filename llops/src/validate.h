// `validate`: parse a module and report the straightline v1 invariants.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Request: { "module": "<ir text>" }
// Response: { "ok": true, "conforms": bool, "diagnostics": [ ... ] }
// A response is ok when the module parses; conforms says whether it is a v1
// program, and the diagnostics say why not.
llvm::json::Object validateCmd(llvm::json::Object &args);

} // namespace llops
