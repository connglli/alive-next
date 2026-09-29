#include "validate.h"

#include "irutil.h"

#include "llvm/IR/Attributes.h"
#include "llvm/IR/ConstantRange.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Module.h"
#include "llvm/Support/ModRef.h"
#include "llvm/Support/raw_ostream.h"

#include <string>

namespace llops {

namespace {

std::string typeText(const llvm::Type *T) {
  std::string out;
  llvm::raw_string_ostream os(out);
  T->print(os);
  return out;
}

// The function's types with every attribute on them, where the IR places each.
std::string signatureOf(const llvm::Function &F) {
  const llvm::AttributeList &AL = F.getAttributes();
  std::string ret = AL.getRetAttrs().getAsString();
  std::string sig = (ret.empty() ? "" : ret + " ") + typeText(F.getReturnType()) + "(";
  for (const llvm::Argument &arg : F.args()) {
    std::string words = AL.getParamAttrs(arg.getArgNo()).getAsString();
    sig +=
        (arg.getArgNo() ? ", " : "") + typeText(arg.getType()) + (words.empty() ? "" : " " + words);
  }
  sig += ")";
  std::string fn = AL.getFnAttrs().getAsString();
  return fn.empty() ? sig : sig + " {" + fn + "}";
}

llvm::json::Object extractFunctions(llvm::Module &M) {
  llvm::json::Object funcs;
  for (const llvm::Function &F : M) {
    if (F.isIntrinsic())
      continue;

    llvm::json::Object fObj;
    fObj["defined"] = !F.isDeclaration();

    fObj["return_type"] = typeText(F.getReturnType());

    llvm::json::Array paramsArr;
    unsigned idx = 0;
    for (const llvm::Argument &arg : F.args()) {
      llvm::json::Object pObj;
      pObj["index"] = (int64_t)idx;
      pObj["type"] = typeText(arg.getType());

      llvm::json::Object pAttrs;
      if (F.hasParamAttribute(idx, llvm::Attribute::NoUndef)) {
        pAttrs["noundef"] = true;
      }
      if (F.hasParamAttribute(idx, llvm::Attribute::NonNull)) {
        pAttrs["nonnull"] = true;
      }
      if (F.hasParamAttribute(idx, llvm::Attribute::Alignment)) {
        uint64_t align = F.getParamAlign(idx).valueOrOne().value();
        pAttrs["align"] = (int64_t)align;
      }
      if (F.hasParamAttribute(idx, llvm::Attribute::Dereferenceable)) {
        uint64_t bytes = F.getParamDereferenceableBytes(idx);
        pAttrs["dereferenceable"] = (int64_t)bytes;
      }
      if (F.hasParamAttribute(idx, llvm::Attribute::Range)) {
        llvm::Attribute attr = F.getParamAttribute(idx, llvm::Attribute::Range);
        if (attr.isValid()) {
          llvm::ConstantRange CR = attr.getRange();
          int64_t minVal = CR.getLower().getSExtValue();
          int64_t maxVal = CR.getUpper().getSExtValue();
          llvm::json::Object rObj;
          rObj["min"] = minVal;
          rObj["max"] = maxVal;
          pAttrs["range"] = std::move(rObj);
        }
      }

      pObj["attrs"] = std::move(pAttrs);
      paramsArr.push_back(std::move(pObj));
      idx++;
    }
    fObj["params"] = std::move(paramsArr);

    llvm::json::Object fnAttrs;
    if (F.hasFnAttribute(llvm::Attribute::NoUnwind)) {
      fnAttrs["nounwind"] = true;
    }
    if (F.hasFnAttribute(llvm::Attribute::NoFree)) {
      fnAttrs["nofree"] = true;
    }
    if (F.hasFnAttribute(llvm::Attribute::NoSync)) {
      fnAttrs["nosync"] = true;
    }
    if (F.hasFnAttribute(llvm::Attribute::WillReturn)) {
      fnAttrs["willreturn"] = true;
    }
    if (F.hasFnAttribute(llvm::Attribute::NoRecurse)) {
      fnAttrs["norecurse"] = true;
    }
    if (F.hasFnAttribute(llvm::Attribute::MustProgress)) {
      fnAttrs["mustprogress"] = true;
    }
    auto ME = F.getMemoryEffects();
    if (ME.doesNotAccessMemory()) {
      fnAttrs["memory"] = "none";
    } else if (ME.onlyReadsMemory()) {
      fnAttrs["memory"] = "read";
    } else if (ME.onlyWritesMemory()) {
      fnAttrs["memory"] = "write";
    } else if (ME.onlyAccessesArgPointees()) {
      auto info = ME.getModRef(llvm::MemoryEffects::Location::ArgMem);
      if (info == llvm::ModRefInfo::Ref) {
        fnAttrs["memory"] = "argmem: read";
      } else if (info == llvm::ModRefInfo::Mod) {
        fnAttrs["memory"] = "argmem: write";
      } else {
        fnAttrs["memory"] = "argmem: readwrite";
      }
    }
    fObj["fn_attrs"] = std::move(fnAttrs);

    fObj["signature"] = signatureOf(F);
    fObj["bare"] = F.getAttributes().isEmpty();

    funcs[F.getName().str()] = std::move(fObj);
  }
  return funcs;
}

} // namespace

llvm::json::Object validateCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  if (!text)
    return errResponse("bad_request", "validate needs 'module'");

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);

  auto diags = validateModule(*mwc->mod);
  llvm::json::Object resp;
  resp["ok"] = true;
  resp["conforms"] = diags.empty();
  llvm::Function *F = singleFunction(*mwc->mod);
  resp["cyclic"] = F && holdsLoop(*F);
  addDiagnostics(resp, diags);
  resp["functions"] = extractFunctions(*mwc->mod);
  return resp;
}

} // namespace llops
