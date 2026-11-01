// The `respected` subcommand.
#pragma once

#include "llvm/IR/Function.h"
#include "llvm/IR/Module.h"
#include "llvm/Support/JSON.h"

namespace llops {

// Whether body attributes hold on the function's accesses, calls and pointer
// uses, with return noundef also compared where the returned values cannot be
// poison. A successful check certifies refinement without a solver.
llvm::json::Object respectedCmd(llvm::json::Object &args);

// Remove checked body attributes and return noundef where it is proved redundant.
void dropCheckedAttrs(llvm::Function &F);

// Remove every lifetime marker and the declarations that leaves unused.
void dropLifetimeMarkers(llvm::Module &M);

} // namespace llops
