// `canon`: parse, refuse an `undef` value, renumber every local value,
// print. The certificate checker compares programs as bytes, so this is what
// makes "identical up to names" decidable by string comparison, and the
// no-undef model holds because nothing becomes a stored program without
// passing here. It is also the only operation in llops that renames anything.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object canonCmd(llvm::json::Object &args);

} // namespace llops
