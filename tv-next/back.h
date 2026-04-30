// alive-tv-next: intra-function backward SSA slice (Phase 5).
//
// Traces data-flow dependencies of a named SSA value upward through a
// function via BFS on def-use edges in reverse, collecting the contributing
// instruction set and returning it in program order alongside the function
// arguments that serve as leaf roots.
//
// The result is a DAG (no back-edges in SSA form), directly usable as input
// to computeRanges (range.h) or as a source of instructions to lift into a
// TvUnit (e.g., for the assume-check of a freeze-drop proposer).

#pragma once

#include "llvm/IR/Argument.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Instruction.h"

#include <optional>
#include <string>
#include <vector>

namespace alive_tv_next {

struct BackwardSlice {
  std::vector<llvm::Instruction *> insts; // program order within fn
  std::vector<llvm::Argument *>
      arg_roots; // fn args that appear as leaves, by argno
};

// Collect the backward slice of the instruction named `name` in `fn`.
// Returns std::nullopt if no instruction with that name exists in `fn`.
std::optional<BackwardSlice> collectBackwardSlice(const std::string &name,
                                                  const llvm::Function &fn);

} // namespace alive_tv_next
