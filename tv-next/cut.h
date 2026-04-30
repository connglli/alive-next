// alive-tv-next: build a small @src/@tgt llvm::Function pair from a
// `DiffGroup` (one or more consecutive diff positions).
//
// Phase 1+2: equal instruction counts on src and tgt within the group.
// Each group instruction is cloned into the cut function and rewired:
//   - Constants are inlined unchanged.
//   - Operands defined *within* the group (internal) are rewired to their
//     cloned counterparts.
//   - Operands defined *outside* the group (external) are unioned by SSA
//     name across src and tgt and become parameters of the cut function.
// The cut returns the value of the *last* group instruction on each side.
//
// A 1-position group recovers Phase 1's single-instr cut behaviour.

#pragma once

#include "tv-next/diff.h"

#include "llvm/IR/Function.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"

#include <memory>
#include <optional>
#include <string>

namespace alive_tv_next {

// One built cut, owning its own Module so it can be safely fed to alive2
// and discarded afterward.
struct Cut {
  std::unique_ptr<llvm::Module> module;
  llvm::Function *src_fn = nullptr;  // named "src" in `module`
  llvm::Function *tgt_fn = nullptr;  // named "tgt" in `module`
  std::string name;                  // for diagnostics, e.g. "cut@i3..i4"
};

// Build a cut for a `DiffGroup`. Returns std::nullopt and prints a
// diagnostic on errs() if the lift can't be done — currently:
//   - empty group
//   - any instruction is a terminator
//   - the group's exit (last position) has void result type
//   - src and tgt result types disagree at any position
//   - any non-constant external operand lacks an explicit SSA name
//   - same-name external operand has differing types in src vs tgt
std::optional<Cut> buildGroupCut(const DiffGroup &group,
                                 llvm::Module &parent_module,
                                 llvm::LLVMContext &ctx,
                                 const std::string &diag_name);

}  // namespace alive_tv_next
