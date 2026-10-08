#include "attrs.h"

#include "llvm/ADT/STLExtras.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/InstrTypes.h"
#include "llvm/Support/ModRef.h"

namespace llops {

namespace {

using Attr = llvm::Attribute;

// What alive2's handleFnAttrs reads, with the memory effects.
const Attr::AttrKind kFnBody[] = {
    Attr::Memory,    Attr::NoFree,    Attr::NoReturn,           Attr::WillReturn,
    Attr::AllocSize, Attr::AllocKind, Attr::NullPointerIsValid,
};
const llvm::StringRef kFnStrings[] = {
    "denormal-fp-math",
    "denormal-fp-math-f32",
    "alloc-family",
};
// What alive2's handleParamAttrs reads on the checked function.
const Attr::AttrKind kParamValue[] = {
    Attr::InReg,
    Attr::SExt,
    Attr::ZExt,
    Attr::ByVal,
    Attr::NonNull,
    Attr::Alignment,
    Attr::NoUndef,
    Attr::Range,
    Attr::NoFPClass,
    Attr::Writable,
    Attr::Dereferenceable,
    Attr::DereferenceableOrNull,
    Attr::DeadOnUnwind,
    Attr::DeadOnReturn,
};
const Attr::AttrKind kParamBody[] = {
    Attr::ReadOnly,    Attr::WriteOnly,        Attr::ReadNone,   Attr::Returned,
    Attr::Initializes, Attr::AllocatedPointer, Attr::AllocAlign,
};
// What alive2's handleRetAttrs reads, with the range it reads where the function returns.
const Attr::AttrKind kRetValue[] = {
    Attr::SExt,
    Attr::ZExt,
    Attr::NoAlias,
    Attr::NonNull,
    Attr::NoUndef,
    Attr::Alignment,
    Attr::NoFPClass,
    Attr::Range,
    Attr::Dereferenceable,
    Attr::DereferenceableOrNull,
};

// The list without the function and return attributes alive2 ignores.
llvm::AttributeList cleaned(llvm::LLVMContext &C, llvm::AttributeList list) {
  llvm::AttributeSet fn = list.getFnAttrs(), ret = list.getRetAttrs();
  for (const Attr &A : fn)
    if (fnAttrMeaning(A) == AttrMeaning::Ignored)
      list = A.isStringAttribute() ? list.removeFnAttribute(C, A.getKindAsString())
                                   : list.removeFnAttribute(C, A.getKindAsEnum());
  for (const Attr &A : ret)
    if (retAttrMeaning(A) == AttrMeaning::Ignored)
      list = A.isStringAttribute() ? list.removeRetAttribute(C, A.getKindAsString())
                                   : list.removeRetAttribute(C, A.getKindAsEnum());
  return list;
}

} // namespace

AttrMeaning fnAttrMeaning(const llvm::Attribute &A) {
  bool read = A.isStringAttribute() ? llvm::is_contained(kFnStrings, A.getKindAsString())
                                    : llvm::is_contained(kFnBody, A.getKindAsEnum());
  return read ? AttrMeaning::Body : AttrMeaning::Ignored;
}

AttrMeaning paramAttrMeaning(const llvm::Attribute &A) {
  // alive2 aborts on a string attribute here, which refuses the function too.
  if (A.isStringAttribute())
    return AttrMeaning::Refused;
  Attr::AttrKind kind = A.getKindAsEnum();
  if (kind == Attr::Captures) {
    bool none = llvm::capturesNothing(A.getCaptureInfo());
    return none ? AttrMeaning::Body : AttrMeaning::Refused;
  }
  if (llvm::is_contained(kParamValue, kind))
    return AttrMeaning::Value;
  return llvm::is_contained(kParamBody, kind) ? AttrMeaning::Body : AttrMeaning::Refused;
}

AttrMeaning retAttrMeaning(const llvm::Attribute &A) {
  bool read = !A.isStringAttribute() && llvm::is_contained(kRetValue, A.getKindAsEnum());
  return read ? AttrMeaning::Value : AttrMeaning::Ignored;
}

void dropIgnoredAttrs(llvm::Module &M) {
  for (llvm::Function &F : M) {
    F.setAttributes(cleaned(M.getContext(), F.getAttributes()));
    for (llvm::Instruction &I : llvm::instructions(F))
      if (auto *call = llvm::dyn_cast<llvm::CallBase>(&I))
        call->setAttributes(cleaned(M.getContext(), call->getAttributes()));
  }
  for (llvm::GlobalValue &G : M.global_values())
    G.setUnnamedAddr(llvm::GlobalValue::UnnamedAddr::None);
}

} // namespace llops
