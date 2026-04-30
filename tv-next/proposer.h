// alive-tv-next: hand-coded assume proposers (Phase 3).
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
// Phase 3 ships one proposer:
//   - `tryNoOverflowMulFromExt` — covers Variant A. Recognizes a
//     `mul A, B` → `mul nsw A', B'` rewrite when both operands trace
//     back through one integer extension (sext or zext) in the parent
//     @src to the mul's destination type. Proposes the assume "A * B
//     doesn't signed-overflow" via `llvm.smul.with.overflow.iN`. The
//     standalone assume-check rebuilds the extension chain on the
//     parent's pre-extension inputs and asks alive2 to prove the
//     overflow-free predicate — so feasibility for any (M, K, N)
//     bitwidth combo (e.g., M+K ≤ N) is decided by the prover, not
//     hardcoded here.
//
// Future proposers (Phase 4 / corpus) plug into the same dispatcher
// (`proposeAssume`) and follow the same shape.

#pragma once

#include "tv-next/cut.h"

#include "llvm/IR/Function.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"

#include <memory>
#include <optional>
#include <string>

namespace alive_tv_next {

// What a proposer returns when it fires. Both `modified_cut` and
// `assume_check` are independent Cuts (each owning its own Module) so
// alive2 can verify them as standard Transforms.
struct AssumedCut {
  Cut modified_cut;     // injected `llvm.assume(cond)`
  Cut assume_check;     // proves `cond` always holds in the parent's input space
  std::string proposer_name;
};

// Try every hand-coded proposer in turn. Returns the first that fires;
// std::nullopt if none match.
std::optional<AssumedCut> proposeAssume(const Cut &original_cut,
                                        llvm::Function &parent_src,
                                        llvm::Module &parent_module,
                                        llvm::LLVMContext &ctx);

}  // namespace alive_tv_next
