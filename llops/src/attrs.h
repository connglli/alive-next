// Attributes: how alive2 treats each one by where it sits, and `attrs`, which
// puts them on a function or a parameter as docs/llops.md sets out.
//
// alive2 gives some attributes a meaning, ignores the others on a function or
// a return value, and refuses to check a function with a parameter attribute
// it does not read. attrs.cpp lists every attribute alive2 reads, from its
// llvm2alive.cpp at the pinned revision; recheck it when alive2 is updated.
#pragma once

#include "llvm/IR/Attributes.h"
#include "llvm/IR/Module.h"
#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object attrsCmd(llvm::json::Object &args);

// What an attribute means to alive2 where it sits.
enum class AttrMeaning {
  Ignored, // no meaning at all
  Refused, // alive2 does not check a function that has it
  Value,   // about an argument coming in or the value going out
  Body,    // about what the body may do, or the mode its instructions run in
};

AttrMeaning fnAttrMeaning(const llvm::Attribute &A);
AttrMeaning paramAttrMeaning(const llvm::Attribute &A);
AttrMeaning retAttrMeaning(const llvm::Attribute &A);

// Remove the attributes alive2 ignores from every function and call, and unnamed_addr.
void dropIgnoredAttrs(llvm::Module &M);

} // namespace llops
