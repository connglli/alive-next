// alive-tv-next: lightweight straight-line range analysis (Phase 5).
//
// Single forward pass over straight-line code (no fixed-point iteration —
// TvUnits and their parent slices are SSA DAGs with no back-edges).
//
// KnownRange optionally carries an unsigned interval, a signed interval,
// or both, all in the value's own bitwidth. Transfer functions select the
// right interpretation per opcode+flags. Cross-derivation fills in the
// complementary bound for free when it follows: if u.hi has the high bit
// clear, s follows; if s.lo ≥ 0, u follows.
//
// In addition to bounds, each entry tracks whether the value is guaranteed
// free of undef and free of poison — which are distinct in LLVM semantics:
//   undef:  a per-use arbitrary bit-pattern (chosen independently each use).
//   poison: a "tainted" marker that propagates through most operations and
//           causes UB when consumed in certain ways.
// `freeze` is the defined escape hatch for both: its output is always
// undef-free and poison-free regardless of its input.
// The combined `well_defined()` flag (undef_free && poison_free) means the
// value is a concrete integer — range bounds are tight and freeze is the
// identity.
//
// Coverage:
//   ConstantInt, and, or, urem, udiv, lshr, ashr, shl (+nuw/nsw),
//   add/sub/mul (+nuw/nsw), select, freeze, zext, sext, trunc.
//
// Untrusted — alive2 gates every predicate the proposers derive.

#pragma once

#include "llvm/ADT/APInt.h"
#include "llvm/ADT/ArrayRef.h"
#include "llvm/IR/Instruction.h"
#include "llvm/IR/Value.h"

#include <map>
#include <optional>
#include <utility>

namespace alive_tv_next {

struct KnownRange {
  // Closed intervals in the value's bitwidth. Either or both may be absent.
  // An entry with no bounds but with flags set (e.g. from freeze) is valid.
  std::optional<std::pair<llvm::APInt, llvm::APInt>> u; // unsigned [lo, hi]
  std::optional<std::pair<llvm::APInt, llvm::APInt>> s; // signed   [lo, hi]

  // Well-definedness flags. undef and poison are distinct:
  //   undef_free:  value is definitely not undef  (but may be poison).
  //   poison_free: value is definitely not poison (but may be undef).
  bool undef_free = false;
  bool poison_free = false;

  // Both flags: value is a concrete integer. freeze(v) == v holds iff
  // well_defined() is true for v.
  bool well_defined() const {
    return undef_free && poison_free;
  }
};

// Map from Value* to its known range. Only values with derivable information
// (bounds or flags) appear; absent means unknown.
using RangeMap = std::map<const llvm::Value *, KnownRange>;

// Single forward pass over `insts` (program order, no cycles).
// Constant operands are handled lazily inside the pass.
// `seed` pre-populates ranges for function arguments or other external values
// (e.g. set undef_free=true for arguments under --disable-undef-input).
RangeMap computeRanges(llvm::ArrayRef<llvm::Instruction *> insts,
                       const RangeMap &seed = {});

} // namespace alive_tv_next
