// `analyze`: run an LLVM analysis at a program point and report facts as JSON
// shaped for attributes and assumes. Analyses are untrusted proposers: a fact
// enters a certificate only through a step alive2 proves, so a wrong fact
// costs time and cannot cost soundness.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Request: { "module": "...", "kind": "knownbits"|"ranges"|"pointer",
//            "point": ref }
// The point defaults to the end of the body. Facts are reported for every
// argument and every value defined before the point that the analysis applies
// to, and they hold just before the point runs, so an llvm.assume earlier in
// the body counts.
//
// Response: { "ok": true, "kind": ..., "point": ref, "facts": [ ... ] }
//   knownbits  { "value", "type", "zero_bits", "one_bits", "unknown_bits" }
//   ranges     { "value", "type", "signed_min", "signed_max",
//                "unsigned_min", "unsigned_max" }
//   pointer    { "value", "type", "align", "dereferenceable", "nonnull" }
llvm::json::Object analyzeCmd(llvm::json::Object &args);

} // namespace llops
