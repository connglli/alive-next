// `poison`: make one parameter of a function poison. A proof by cases uses
// the result as its case for the inputs that pass poison to that parameter.
// The request is in docs/llops.md.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object poisonCmd(llvm::json::Object &args);

} // namespace llops
