// The `number` subcommand.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Print a program with each instruction of its body marked `; #N`, the
// reference that names it. The marks and `#N` both come from
// `ValueRefs::indexOf`, so what a reader sees and what a request means cannot
// disagree.
llvm::json::Object numberCmd(llvm::json::Object &args);

} // namespace llops
