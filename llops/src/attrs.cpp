#include "attrs.h"

#include "irutil.h"

#include "llvm/ADT/STLExtras.h"
#include "llvm/IR/ConstantRange.h"
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

namespace {

// Add one parameter attribute described by a JSON entry. Attributes are
// proposals: an attribute the program does not honour turns into UB, which
// is what the caller's alive2 check is there to catch.
bool addParamAttr(llvm::Argument &arg, llvm::StringRef kind, const llvm::json::Value &val,
                  llvm::json::Object &err) {
  llvm::LLVMContext &ctx = arg.getContext();
  auto simple = [&](llvm::Attribute::AttrKind k) {
    arg.addAttr(llvm::Attribute::get(ctx, k));
    return true;
  };
  if (kind == "noundef")
    return simple(llvm::Attribute::NoUndef);
  if (kind == "nonnull")
    return simple(llvm::Attribute::NonNull);
  if (kind == "noalias")
    return simple(llvm::Attribute::NoAlias);
  if (kind == "align") {
    auto bytes = val.getAsInteger();
    if (!bytes || *bytes <= 0 || !llvm::isPowerOf2_64((uint64_t)*bytes)) {
      err = errResponse("invalid", "align must be a positive power of two");
      return false;
    }
    arg.addAttr(llvm::Attribute::getWithAlignment(ctx, llvm::Align((uint64_t)*bytes)));
    return true;
  }
  if (kind == "dereferenceable") {
    auto bytes = val.getAsInteger();
    if (!bytes || *bytes <= 0) {
      err = errResponse("invalid", "dereferenceable must be a positive byte count");
      return false;
    }
    arg.addAttr(llvm::Attribute::getWithDereferenceableBytes(ctx, (uint64_t)*bytes));
    return true;
  }
  if (kind == "range") {
    auto *range = val.getAsObject();
    auto min = range ? range->getInteger("min") : std::nullopt;
    auto max = range ? range->getInteger("max") : std::nullopt;
    if (!min || !max) {
      err = errResponse("invalid", "range needs {\"min\": n, \"max\": m}");
      return false;
    }
    if (!arg.getType()->isIntegerTy()) {
      err = errResponse("invalid", "range applies to integer parameters only");
      return false;
    }
    unsigned bits = arg.getType()->getIntegerBitWidth();
    if (bits < 64 && (!llvm::isIntN(bits, *min) || !llvm::isIntN(bits, *max))) {
      err = errResponse("invalid", "range bounds do not fit the parameter type");
      return false;
    }
    // The range is the half-open interval [min, max), so the two bounds being
    // equal describes no value at all.
    if (*min == *max) {
      err = errResponse("invalid", "range must be a non-empty half-open interval");
      return false;
    }
    llvm::AttrBuilder B(ctx);
    B.addRangeAttr(llvm::ConstantRange(llvm::APInt(bits, (uint64_t)*min, true),
                                       llvm::APInt(bits, (uint64_t)*max, true)));
    arg.addAttrs(B);
    return true;
  }
  err = errResponse("invalid", "unknown attribute '" + kind.str() + "'");
  return false;
}

// Add one function-level attribute to a function definition or declaration.
bool addFunctionAttr(llvm::Function &F, llvm::StringRef kind, const llvm::json::Value &val,
                     llvm::json::Object &err) {
  auto simple = [&](llvm::Attribute::AttrKind k) {
    auto b = val.getAsBoolean();
    if (!b || !*b) {
      err = errResponse("invalid", "'" + kind.str() + "' must be true");
      return false;
    }
    F.addFnAttr(k);
    return true;
  };
  if (kind == "nounwind")
    return simple(llvm::Attribute::NoUnwind);
  if (kind == "nofree")
    return simple(llvm::Attribute::NoFree);
  if (kind == "nosync")
    return simple(llvm::Attribute::NoSync);
  if (kind == "willreturn")
    return simple(llvm::Attribute::WillReturn);
  if (kind == "norecurse")
    return simple(llvm::Attribute::NoRecurse);
  if (kind == "mustprogress")
    return simple(llvm::Attribute::MustProgress);
  if (kind == "memory") {
    auto memStr = val.getAsString();
    if (!memStr) {
      err = errResponse("invalid", "memory attribute needs a string (e.g. \"none\")");
      return false;
    }
    if (*memStr == "none") {
      F.setMemoryEffects(llvm::MemoryEffects::none());
      return true;
    }
    if (*memStr == "read") {
      F.setMemoryEffects(llvm::MemoryEffects::readOnly());
      return true;
    }
    if (*memStr == "write") {
      F.setMemoryEffects(llvm::MemoryEffects::writeOnly());
      return true;
    }
    if (*memStr == "argmem: readwrite") {
      F.setMemoryEffects(llvm::MemoryEffects::argMemOnly(llvm::ModRefInfo::ModRef));
      return true;
    }
    if (*memStr == "argmem: read") {
      F.setMemoryEffects(llvm::MemoryEffects::argMemOnly(llvm::ModRefInfo::Ref));
      return true;
    }
    if (*memStr == "argmem: write") {
      F.setMemoryEffects(llvm::MemoryEffects::argMemOnly(llvm::ModRefInfo::Mod));
      return true;
    }
    err = errResponse("invalid", "unsupported memory effect '" + memStr->str() + "'");
    return false;
  }
  err = errResponse("invalid", "unknown function attribute '" + kind.str() + "'");
  return false;
}

} // namespace

llvm::json::Object attrsCmd(llvm::json::Object &args) {
  CmdShape shape;
  llvm::json::Object shapeErr;
  if (!parseCmdShape(args, "attrs", shape, shapeErr))
    return shapeErr;
  auto fnName = args.getString("fn");
  auto param = args.getInteger("param");
  auto attrs = args.getObject("attrs");
  if (!fnName || !attrs)
    return errResponse("bad_request", "attrs needs 'fn' and 'attrs'");
  if (args.get("param") && !param)
    return errResponse("bad_request", "attrs: 'param' must be an integer");
  llvm::Function *F = shape.M->getFunction(*fnName);
  if (!F)
    return errResponse("not_found", "attrs: no function named '" + fnName->str() + "'");
  if (param.has_value()) {
    if (*param < 0 || (uint64_t)*param >= F->arg_size())
      return errResponse("invalid", "attrs: parameter index out of range");
    llvm::Argument &arg = *std::next(F->arg_begin(), (unsigned)*param);
    for (const auto &entry : *attrs) {
      llvm::json::Object err;
      if (!addParamAttr(arg, entry.first, entry.second, err))
        return err;
    }
  } else {
    for (const auto &entry : *attrs) {
      llvm::json::Object err;
      if (!addFunctionAttr(*F, entry.first, entry.second, err))
        return err;
    }
  }
  return checkedResponse(*shape.M);
}

} // namespace llops
