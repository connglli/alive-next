// `edit`: apply one semantic edit op to a module and return the new text.
//
// The op catalog mirrors docs/design.md, plus `attrs`, which the strengthen
// flow uses to put a proved fact on a parameter of the outlined callee.
//
// An edit answers with the module as printed, keeping every name it was
// given, so that a transaction can address the values it just created. Only
// `canon` renumbers.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

// Request: { "module": "<ir text>", "op": "<op>", ...op arguments }
//
//   swap        { "a": ref, "b": ref }
//   move        { "v": ref, "where": "before"|"after", "w": ref }
//   substitute  { "a": ref, "b": ref }          every use of a becomes b
//   replace     { "v": ref, "insts": [ ... ] }  v is redefined by the snippet
//   insert      { "where": "before"|"after", "w": ref, "insts": [ ... ] }
//   erase       { "v": ref, "cascade": bool }   cascade drops dead operands
//   commute     { "v": ref }
//   retype      { "v": ref, "ty": "i16", "ext": "zext"|"sext" }
//   dedup       { "a": ref, "b": ref }          b is erased in favour of a
//   set_body    { "body": "<instruction text>" }
//   attrs       { "fn": "g", "param": 0, "attrs": { ... } }
//
// A ref names a value the way printed IR does; see ValueRefs in irutil.h.
// Attribute names are noundef, nonnull, noalias, align, dereferenceable and
// range, the last two taking a byte count and a { "min", "max" } pair.
//
// Response: { "ok": true, "module": "<ir text>" } or an error. An edit whose
// result would not be well formed straightline IR is rejected and answers
// with the diagnostic alone, so the caller keeps the module it had.
llvm::json::Object editCmd(llvm::json::Object &args);

} // namespace llops
