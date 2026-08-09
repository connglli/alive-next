// `assume`: state a fact about a value, where the evidence for it lives. The
// fact vocabulary and the request are in docs/llops.md.
//
// This is the first half of interface strengthening. An attribute on an
// outlined callee's parameter is an assumption its caller has to honour, so it
// may only be added once the caller has been shown to honour it, and inserting
// `llvm.assume` is how that is shown: if the fact were false the assume would
// add UB the program did not have, and the alive2 check of the insertion
// refuses it.
//
// The same vocabulary serves both halves, so what is proved here and what is
// attributed by `edit attrs` cannot drift apart. A fact whose attribute has no
// assume form is refused rather than quietly skipped.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object assumeCmd(llvm::json::Object &args);

} // namespace llops
