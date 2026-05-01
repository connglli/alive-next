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
// ## Registered patterns (proposer.cpp `kPatterns`)
//
//   - NoOverflowMulFromExt — `mul A, B` → `mul nsw A', B'` when both
//     operands trace through a single integer extension (sext/zext) in
//     parent @src. Proposes "smul doesn't overflow".
//
//   - FreezeDropFromRange — `freeze(arg)` present in @src, absent in
//     @tgt, and `arg` is a `shl %v, %amt` in parent @src where range
//     analysis proves `%amt < bitwidth`. Proposes "arg is non-poison".
//
// ## How to add a new pattern
//
// Append a lambda with type `AssumeProposerFn` to `kPatterns` in
// proposer.cpp. The lambda receives the original TvUnit, the parent @src
// function, its Module, and the LLVMContext. Return `AssumedTvUnit` if
// the pattern fires, `std::nullopt` otherwise. Use `llvm::PatternMatch`
// for shape recognition and the shared helpers (`buildModifiedTvUnit`,
// `buildNoPoisonModifiedTvUnit`, etc.) for TvUnit construction.
// No changes to `proposeAssume` are needed — it iterates `kPatterns`
// automatically, then falls back to `proposeFromRanges`.

#pragma once

#include "tv-next/unit.h"

#include "llvm/IR/Function.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"

#include <functional>
#include <memory>
#include <optional>
#include <string>

namespace alive_tv_next {

// What a proposer returns when it fires. Both `modified_unit` and
// `assume_check` are independent TvUnits (each owning its own Module) so
// alive2 can verify them as standard Transforms.
struct AssumedTvUnit {
  TvUnit modified_unit; // injected `llvm.assume(cond)`
  TvUnit assume_check; // proves `cond` always holds in the parent's input space
  std::string proposer_name;
};

// Signature for a single pattern lambda. Append a lambda with this type to
// `kPatterns` in proposer.cpp to register a new pattern — no other changes
// needed. The lambda should return AssumedTvUnit if the pattern fires and
// std::nullopt if it does not match.
using AssumeProposerFn = std::function<std::optional<AssumedTvUnit>(
    const TvUnit &, llvm::Function &parent_src, llvm::Module &parent_module,
    llvm::LLVMContext &)>;

// Try every registered pattern in turn, then fall back to proposeFromRanges.
// Returns the first result that fires; std::nullopt if none match.
std::optional<AssumedTvUnit> proposeAssume(const TvUnit &original_unit,
                                           llvm::Function &parent_src,
                                           llvm::Module &parent_module,
                                           llvm::LLVMContext &ctx);

} // namespace alive_tv_next
