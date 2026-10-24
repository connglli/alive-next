// Attributes as alive2 reads them, and the `attrs` subcommand.
#pragma once

#include "llvm/IR/Attributes.h"
#include "llvm/IR/Module.h"
#include "llvm/Support/JSON.h"

#include <optional>

namespace llops {

// Put attributes on a function, a parameter or the return value.
llvm::json::Object attrsCmd(llvm::json::Object &args);

// What an attribute means to alive2 where it sits.
enum class AttrMeaning {
  Ignored, // no meaning at all
  Refused, // alive2 does not check a function that has it
  Value,   // about an argument coming in or the value going out
  Body,    // about what the body may do, or the mode its instructions run in
};

// How alive2 treats each attribute by where it sits. alive2 gives some
// attributes a meaning and ignores the others on a function or a return value.
// On a parameter it drops a captures attribute other than captures(none), with
// a warning, and refuses to check a function with any other attribute it does
// not read. attrs.cpp lists every attribute alive2 reads, from its
// llvm2alive.cpp at the pinned revision; recheck it when alive2 is updated.
AttrMeaning fnAttrMeaning(const llvm::Attribute &A);
AttrMeaning paramAttrMeaning(const llvm::Attribute &A);
AttrMeaning retAttrMeaning(const llvm::Attribute &A);

// The attribute, of `arg` or of its function, that makes a poison `arg` UB to alive2.
std::optional<llvm::Attribute::AttrKind> poisonUB(const llvm::Argument &arg);

// Remove the attributes alive2 ignores from every function and call, and unnamed_addr.
void dropIgnoredAttrs(llvm::Module &M);

} // namespace llops
