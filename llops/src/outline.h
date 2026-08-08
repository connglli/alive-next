// `outline` and `inline`: the split transformation and its inverse.
//
// outline cuts one side of a goal at a cut point: the instructions before the
// cut stay in the outer function, which gains a call, and the instructions
// from the cut onwards become the body of a fresh function `g`. The cut
// instruction itself is the first instruction of the callee.
//
// The callee signature is the src side's live-in set, the values the suffix
// uses from the prefix or from the arguments, in the order they are defined.
// The tgt side is outlined against that same signature, with a value map
// naming the tgt value that stands in for each src live value. Nothing here
// checks that the map is right; that is what the outer alive2 check does.
//
// `g` is declared with no attributes. An attribute is an assumption the call
// site has to honour, so adding one is a proof obligation that belongs to the
// strengthen flow, not to the cut.
//
// The faithfulness of the transformation is mechanical: `inline` substitutes
// the callee body back at the call site and drops the declaration that
// carried it, so the certificate checker can compare the canonical text
// against the original. See docs/llops.md for the request and response.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object outlineCmd(llvm::json::Object &args);

llvm::json::Object inlineCmd(llvm::json::Object &args);

} // namespace llops
