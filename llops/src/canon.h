// `canon`: parse, renumber every local value, print. The certificate checker
// compares programs as bytes, so this is what makes "identical up to names"
// decidable by string comparison. It is also the only operation in llops that
// renames anything.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object canonCmd(llvm::json::Object &args);

} // namespace llops
