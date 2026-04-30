// alive-tv-next: composition checker.
//
// Aggregates per-cut verdicts into a slice-level verdict. Refinement is
// transitive in principle, so the slice verifies whenever every cut
// verifies — provided three load-bearing checks the composer enforces:
//
//   1. Operand-chain consistency: every cut's verification was done over
//      the actual @tgt SSA wiring at that program point.
//   2. Assume-scoping: assumes verified at one cut propagate correctly to
//      cuts that depend on the assumed values (Phase 3+).
//   3. Identity-position strict match: positions classified as "unchanged"
//      match textually + structurally, not just by opcode.
//
// Phase 1 (M1.3) implements:
//   - per-cut verdict aggregation (this file)
//   - identity-position strict match (handled in diff.cpp via textual diff)
//
// Operand-chain consistency and assume-scoping land in later phases as
// the corresponding mechanisms come online.

#pragma once

#include "verify.h"

#include <string>
#include <vector>

namespace alive_tv_next {

struct ComposeResult {
  bool passed = false;
  size_t identical_positions = 0;
  std::vector<CutVerdict> per_cut;
  std::string error_message;
};

// Phase 1 composer: requires every cut in `per_cut` to have passed.
// `identical_positions` is informational (carried from DiffResult).
ComposeResult composeCuts(std::vector<CutVerdict> per_cut,
                          size_t identical_positions);

} // namespace alive_tv_next
