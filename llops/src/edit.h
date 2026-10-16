// The `edit` subcommand.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Apply one semantic edit op to a module and return the new text.
//
// An edit answers with the module as printed, keeping every name it was given,
// so that a transaction can address the values it just created; only `canon`
// renumbers. An edit whose result would not be well formed straightline IR is
// refused, and answers with the diagnostic alone.
llvm::json::Object editCmd(llvm::json::Object &args);

} // namespace llops
