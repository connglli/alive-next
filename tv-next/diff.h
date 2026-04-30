// alive-tv-next: structural diff between paired @src and @tgt functions.
//
// Phase 1 (M1.2):
//   - Single basic block on each side.
//   - Equal instruction count.
//   - Per-line textual comparison: each (src_inst, tgt_inst) pair is either
//     "identical" (same printed form modulo metadata) or a diff position.
//
// Phase 2 (M2.1):
//   - Diff positions are grouped into runs of *consecutive* diffs. An
//     identical position breaks a run. A 1-position group recovers Phase
//     1's single-instr-cut behaviour; multi-position groups are lifted
//     jointly into one Transform (see cut.h, buildGroupCut).
//
// Multi-BB and multi-side (different src/tgt instruction counts) land in
// later phases.

#pragma once

#include "llvm/IR/Function.h"
#include "llvm/IR/Instruction.h"

#include <optional>
#include <vector>

namespace alive_tv_next {

// One position in the function where @src and @tgt differ at the
// instruction level.
struct DiffPosition {
  // Index of the instruction inside the (single) basic block, 0-based,
  // counting only non-terminator instructions in the iteration order.
  size_t inst_idx;

  // The differing instructions. Pointers into the loaded modules; valid
  // for the lifetime of the LoadedSlice that produced them.
  llvm::Instruction *src_inst;
  llvm::Instruction *tgt_inst;
};

// A run of consecutive diff positions, sorted ascending by inst_idx.
// Positions in the same group are lifted together into one cut and
// verified jointly. The group's "exit" instruction is `positions.back()`
// — its value type is the cut's return type.
struct DiffGroup {
  std::vector<DiffPosition> positions;
};

struct DiffResult {
  std::vector<DiffGroup> groups;
  // How many positions matched textually (for verbose reporting).
  size_t identical_count = 0;
};

// Compute the per-line diff and group consecutive diffs.
// Returns std::nullopt and prints a diagnostic on errs() if the Phase 1
// preconditions are violated (multi-BB, BB length mismatch).
std::optional<DiffResult>
computeDiff(llvm::Function &src, llvm::Function &tgt);

}  // namespace alive_tv_next
