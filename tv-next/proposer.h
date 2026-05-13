// alive-tv-next: hand-coded assume proposers.
//
// A proposer recognizes a specific rewrite shape that's sound only under
// a precondition, derives the precondition from the surrounding IR, and
// emits two artifacts:
//
//   1. A *modified cut* with `llvm.assume(cond)` injected before the
//      rewrite on both @src and @tgt sides. This is the cut alive2
//      verifies for the actual rewrite.
//   2. A *standalone assume-check* — a small Transform that recomputes
//      `cond` from the parent function's relevant inputs and asserts it
//      always holds (compared against `i1 true`). This is the soundness
//      gate; if it fails the proposer's hypothesis is wrong and we
//      reject the proposal.
//
// ## How proposeAssume works
//
// `proposeAssume` iterates the hand-coded `kPatterns` list in proposer.cpp,
// then falls back to the generic `proposeFromRanges`. The generic proposer
// is shape-agnostic: it runs range analysis on both `parent_src` and
// `parent_tgt`, collects bound/poison-free facts on every unit argument,
// synthesizes Z3-friendly no-violation predicates for any added overflow/
// non-loss flags in `unit.tgt_fn`, and discharges each side's claims via a
// per-side standalone assume-check.
//
// ## How to add a new hand-coded pattern
//
// Append a lambda with type `AssumeProposerFn` to `kPatterns` in
// proposer.cpp. The lambda receives the original TvUnit, both parent
// functions, and the LLVMContext, returning `AssumedTvUnit` on a hit or
// `std::nullopt` otherwise. Use `llvm::PatternMatch` for shape recognition.
// New patterns are rarely needed — extending the range proposer (richer
// transfer functions, additional flag handlers in the obligation table) is
// usually the better generalization.

#pragma once

#include "tv-next/unit.h"

#include "llvm/IR/Function.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"

#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace alive_tv_next {

// What a proposer returns when it fires. `assume_checks` is a vector because
// some proposers (e.g. the symmetric range proposer) derive claims against
// both `parent_src` and `parent_tgt` and must verify each set against its
// own side. Every entry must pass standalone for the modified unit to be
// accepted.
struct AssumedTvUnit {
  TvUnit modified_unit;              // injected `llvm.assume(cond)`
  std::vector<TvUnit> assume_checks; // each proves a subset of the claims
  std::string proposer_name;
};

// Signature for a single pattern lambda. Both `parent_src` and `parent_tgt`
// are passed; chain-validation guarantees that values at the cut boundary
// agree in well-defined cases, so either side can be used to derive facts.
// Append a lambda with this type to `kPatterns` in proposer.cpp to register
// a new pattern — no other changes needed.
using AssumeProposerFn = std::function<std::optional<AssumedTvUnit>(
    const TvUnit &, llvm::Function &parent_src, llvm::Function &parent_tgt,
    llvm::LLVMContext &)>;

// Try every registered pattern in turn, then fall back to proposeFromRanges.
// Returns the first result that fires; std::nullopt if none match.
std::optional<AssumedTvUnit> proposeAssume(const TvUnit &original_unit,
                                           llvm::Function &parent_src,
                                           llvm::Function &parent_tgt,
                                           llvm::LLVMContext &ctx);

} // namespace alive_tv_next
