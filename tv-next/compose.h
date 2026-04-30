// alive-tv-next: composition checker.
//
// Aggregates per-unit verdicts into a slice-level verdict. Refinement is
// transitive in principle, so the slice verifies whenever every unit
// verifies — provided three load-bearing checks the composer enforces:
//
//   1. Operand-chain consistency: every unit's verification was done over
//      the actual @tgt SSA wiring at that program point.
//   2. Assume-scoping: assumes verified at one unit propagate correctly to
//      units that depend on the assumed values (Phase 3+).
//   3. Identity-position strict match: positions classified as "unchanged"
//      match textually + structurally, not just by opcode.
//
// Phase 1 (M1.3) implements:
//   - per-unit verdict aggregation (this file)
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
  std::vector<UnitVerdict> verdicts;
  std::string error_message;
};

// Phase 1 composer: requires every unit in `verdicts` to have passed.
// `identical_positions` is informational (carried from DiffResult).
ComposeResult composeVerdicts(std::vector<UnitVerdict> verdicts,
                              size_t identical_positions);

} // namespace alive_tv_next
