// alive-tv-next: build a TvUnit (small @src/@tgt function pair) from a
// `DiffRegion` (one or more consecutive diff positions).
//
// Phase 1+2: equal instruction counts on src and tgt within the region.
// Each instruction is cloned into the TvUnit and rewired:
//   - Constants are inlined unchanged.
//   - Operands defined *within* the region (internal) are rewired to their
//     cloned counterparts.
//   - Operands defined *outside* the region (external) are unioned by SSA
//     name across src and tgt and become parameters of the TvUnit functions.
// The TvUnit returns the value of the *last* region instruction on each side.
//
// A 1-position region recovers Phase 1's single-instr cut behaviour.

#pragma once

#include "tv-next/diff.h"

#include "llvm/IR/Function.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"

#include <memory>
#include <optional>
#include <string>

namespace alive_tv_next {

// A small @src/@tgt function pair ready to be fed to alive2. Owns its own
// Module so it can be discarded independently after verification.
struct TvUnit {
  std::unique_ptr<llvm::Module> module;
  llvm::Function *src_fn = nullptr; // named "src" in `module`
  llvm::Function *tgt_fn = nullptr; // named "tgt" in `module`
  std::string name;                 // for diagnostics, e.g. "unit@i3..i4"
};

// Build a TvUnit for a `DiffRegion`. Returns std::nullopt and prints a
// diagnostic on errs() if the lift can't be done — currently:
//   - empty region
//   - any instruction is a terminator
//   - the region's exit (last position) has void result type
//   - src and tgt result types disagree at any position
//   - any non-constant external operand lacks an explicit SSA name
//   - same-name external operand has differing types in src vs tgt
std::optional<TvUnit> buildTvUnit(const DiffRegion &region,
                                  llvm::Module &parent_module,
                                  llvm::LLVMContext &ctx,
                                  const std::string &diag_name);

} // namespace alive_tv_next
