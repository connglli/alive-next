// `edit`: apply one semantic edit op to a module and return the new text.
//
// The op catalog mirrors design.md, plus `attrs`, which the strengthen flow
// uses to put a proved fact on a parameter of the outlined callee. What each
// op takes, and what a snippet may and may not do, is in docs/llops.md.
//
// An edit answers with the module as printed, keeping every name it was
// given, so that a transaction can address the values it just created; only
// `canon` renumbers. An edit whose result would not be well formed
// straightline IR is refused, and answers with the diagnostic alone.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object editCmd(llvm::json::Object &args);

} // namespace llops
