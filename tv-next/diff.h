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
//     identical position breaks a run. A 1-position region recovers Phase
//     1's single-instr-unit behaviour; multi-position regions are lifted
//     jointly into one TvUnit (see unit.h, buildTvUnit).
//
// Multi-BB and asymmetric (different src/tgt instruction counts) cases land
// in later phases.

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
  // for the lifetime of the LoadedSrcTgt that produced them.
  llvm::Instruction *src_inst;
  llvm::Instruction *tgt_inst;
};

// A run of consecutive diff positions, sorted ascending by inst_idx.
// Positions in the same region are lifted together into one TvUnit and
// verified jointly.
//
// Two shapes:
//
//   Symmetric region (is_asymmetric == false):
//     `positions` is non-empty; src and tgt have the same number of
//     differing instructions in the run. The region's exit instruction is
//     `positions.back()`; its value type is the TvUnit's return type.
//
//   Asymmetric region (is_asymmetric == true):
//     `positions` is empty. `src_region` and `tgt_region` hold the full
//     instruction lists for each side of the changed region (possibly
//     different lengths). The TvUnit exits at `src_region.back()` /
//     `tgt_region.back()` — the last instruction on each side (must share
//     a type). `src_start_idx` / `tgt_start_idx` are 0-based indices into
//     the parent function's non-terminator instruction list, for
//     diagnostics only.
struct DiffRegion {
  std::vector<DiffPosition> positions;

  bool is_asymmetric = false;
  std::vector<llvm::Instruction *> src_region;
  std::vector<llvm::Instruction *> tgt_region;
  size_t src_start_idx = 0;
  size_t tgt_start_idx = 0;
};

struct DiffResult {
  std::vector<DiffRegion> regions;
  // How many positions matched textually (for verbose reporting).
  size_t identical_count = 0;
};

// Compute the per-line diff and group consecutive diffs into DiffRegions.
// Returns std::nullopt and prints a diagnostic on errs() if the Phase 1
// preconditions are violated (multi-BB, BB length mismatch).
std::optional<DiffResult> computeDiffRegions(llvm::Function &src,
                                             llvm::Function &tgt);

} // namespace alive_tv_next
