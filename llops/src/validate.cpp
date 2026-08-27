#include "validate.h"

#include "irutil.h"

#include "llvm/ADT/StringExtras.h"
#include "llvm/IR/Attributes.h"
#include "llvm/IR/ConstantRange.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Module.h"
#include "llvm/Support/ModRef.h"
#include "llvm/Support/raw_ostream.h"

#include <algorithm>
#include <string>
#include <vector>

namespace llops {

namespace {

llvm::json::Object extractFunctions(llvm::Module &M) {
  llvm::json::Object funcs;
  for (const llvm::Function &F : M) {
    if (F.isIntrinsic())
      continue;

    llvm::json::Object fObj;
    fObj["defined"] = !F.isDeclaration();

    std::string retStr;
    llvm::raw_string_ostream retOS(retStr);
    F.getReturnType()->print(retOS);
    fObj["return_type"] = retStr;

    llvm::json::Array paramsArr;
    std::vector<std::string> paramSigParts;
    unsigned idx = 0;
    for (const llvm::Argument &arg : F.args()) {
      llvm::json::Object pObj;
      pObj["index"] = (int64_t)idx;
      std::string argTypeStr;
      llvm::raw_string_ostream argOS(argTypeStr);
      arg.getType()->print(argOS);
      pObj["type"] = argTypeStr;

      llvm::json::Object pAttrs;
      std::vector<std::string> pAttrWords;
      if (F.hasParamAttribute(idx, llvm::Attribute::NoUndef)) {
        pAttrs["noundef"] = true;
        pAttrWords.push_back("noundef");
      }
      if (F.hasParamAttribute(idx, llvm::Attribute::NonNull)) {
        pAttrs["nonnull"] = true;
        pAttrWords.push_back("nonnull");
      }
      if (F.hasParamAttribute(idx, llvm::Attribute::Alignment)) {
        uint64_t align = F.getParamAlign(idx).valueOrOne().value();
        pAttrs["align"] = (int64_t)align;
        pAttrWords.push_back("align " + std::to_string(align));
      }
      if (F.hasParamAttribute(idx, llvm::Attribute::Dereferenceable)) {
        uint64_t bytes = F.getParamDereferenceableBytes(idx);
        pAttrs["dereferenceable"] = (int64_t)bytes;
        pAttrWords.push_back("dereferenceable(" + std::to_string(bytes) + ")");
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
          pAttrWords.push_back("range(" + argTypeStr + " " + std::to_string(minVal) + ", " +
                               std::to_string(maxVal) + ")");
        }
      }

      std::string paramSig = argTypeStr;
      if (!pAttrWords.empty()) {
        paramSig += " " + llvm::join(pAttrWords, " ");
      }
      paramSigParts.push_back(paramSig);

      pObj["attrs"] = std::move(pAttrs);
      paramsArr.push_back(std::move(pObj));
      idx++;
    }
    fObj["params"] = std::move(paramsArr);

    llvm::json::Object fnAttrs;
    std::vector<std::string> fnAttrWords;
    if (F.hasFnAttribute(llvm::Attribute::NoUnwind)) {
      fnAttrs["nounwind"] = true;
      fnAttrWords.push_back("nounwind");
    }
    if (F.hasFnAttribute(llvm::Attribute::NoFree)) {
      fnAttrs["nofree"] = true;
      fnAttrWords.push_back("nofree");
    }
    if (F.hasFnAttribute(llvm::Attribute::NoSync)) {
      fnAttrs["nosync"] = true;
      fnAttrWords.push_back("nosync");
    }
    if (F.hasFnAttribute(llvm::Attribute::WillReturn)) {
      fnAttrs["willreturn"] = true;
      fnAttrWords.push_back("willreturn");
    }
    if (F.hasFnAttribute(llvm::Attribute::NoRecurse)) {
      fnAttrs["norecurse"] = true;
      fnAttrWords.push_back("norecurse");
    }
    if (F.hasFnAttribute(llvm::Attribute::MustProgress)) {
      fnAttrs["mustprogress"] = true;
      fnAttrWords.push_back("mustprogress");
    }
    auto ME = F.getMemoryEffects();
    if (ME.doesNotAccessMemory()) {
      fnAttrs["memory"] = "none";
      fnAttrWords.push_back("memory(none)");
    } else if (ME.onlyReadsMemory()) {
      fnAttrs["memory"] = "read";
      fnAttrWords.push_back("memory(read)");
    } else if (ME.onlyWritesMemory()) {
      fnAttrs["memory"] = "write";
      fnAttrWords.push_back("memory(write)");
    } else if (ME.onlyAccessesArgPointees()) {
      auto info = ME.getModRef(llvm::MemoryEffects::Location::ArgMem);
      if (info == llvm::ModRefInfo::Ref) {
        fnAttrs["memory"] = "argmem: read";
        fnAttrWords.push_back("memory(argmem: read)");
      } else if (info == llvm::ModRefInfo::Mod) {
        fnAttrs["memory"] = "argmem: write";
        fnAttrWords.push_back("memory(argmem: write)");
      } else {
        fnAttrs["memory"] = "argmem: readwrite";
        fnAttrWords.push_back("memory(argmem: readwrite)");
      }
    }
    std::sort(fnAttrWords.begin(), fnAttrWords.end());
    fObj["fn_attrs"] = std::move(fnAttrs);

    std::string sig = retStr + "(" + llvm::join(paramSigParts, ", ") + ")";
    if (!fnAttrWords.empty()) {
      sig += " {" + llvm::join(fnAttrWords, ", ") + "}";
    }
    fObj["signature"] = sig;

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
  addDiagnostics(resp, diags);
  resp["functions"] = extractFunctions(*mwc->mod);
  return resp;
}

} // namespace llops
