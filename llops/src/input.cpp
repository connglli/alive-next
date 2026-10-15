#include "input.h"

#include "attrs.h"
#include "irutil.h"

#include "llvm/Support/MathExtras.h"

#include <algorithm>
#include <string>

namespace llops {

namespace {

bool readBytes(const llvm::json::Array &bytes, std::vector<uint8_t> &out, llvm::json::Object &err) {
  for (const auto &entry : bytes) {
    auto value = entry.getAsInteger();
    if (!value || *value < 0 || *value > 255) {
      err = errResponse("invalid", "a byte must be between 0 and 255");
      return false;
    }
    out.push_back(static_cast<uint8_t>(*value));
  }
  return true;
}

// Read an integer argument into the parameter's width.
//
// A counterexample is as often negative as not, and LLVM's own parser reads a
// magnitude only, so the sign is handled here. A value the width cannot hold
// is refused rather than truncated, because a truncated value is not the one
// the caller asked about.
bool readInteger(llvm::StringRef text, unsigned width, llvm::APInt &out, std::string &why) {
  bool negative = text.consume_front("-");
  // Radix 0 would read a leading 0 as octal, which no caller means.
  unsigned radix = text.consume_front_insensitive("0x") ? 16 : 10;
  llvm::APInt magnitude(width, 0);
  if (text.getAsInteger(radix, magnitude)) {
    why = "is not an integer";
    return false;
  }
  // The parse widens rather than truncates, and a sign needs one bit more than
  // the magnitude it applies to.
  llvm::APInt value = magnitude.zext(std::max(magnitude.getBitWidth(), width) + 1);
  if (negative)
    value.negate();
  if (!value.isIntN(width) && !value.isSignedIntN(width)) {
    why = "does not fit in i" + std::to_string(width);
    return false;
  }
  out = value.trunc(width);
  return true;
}

bool readArg(const llvm::Argument &param, const llvm::json::Object &spec, Arg &out,
             llvm::json::Object &err) {
  llvm::Type *paramTy = param.getType();
  unsigned index = param.getArgNo();
  auto kind = spec.getString("kind");
  if (!kind) {
    err = errResponse("bad_request", "each argument needs a 'kind'");
    return false;
  }

  if (*kind == "int") {
    if (!paramTy->isIntegerTy()) {
      err = errResponse("type_mismatch", "argument " + std::to_string(index) +
                                             " is an int, but the parameter "
                                             "is not an integer");
      return false;
    }
    auto text = spec.getString("value");
    if (!text) {
      err = errResponse("bad_request", "an int argument needs a 'value'");
      return false;
    }
    std::string why;
    // The value arrives as text so that a width beyond 64 bits survives JSON.
    if (!readInteger(*text, paramTy->getIntegerBitWidth(), out.value, why)) {
      err = errResponse("invalid",
                        "argument " + std::to_string(index) + ": '" + text->str() + "' " + why);
      return false;
    }
    out.kind = Arg::Kind::Int;
    return true;
  }

  if (*kind == "null") {
    if (!paramTy->isPointerTy()) {
      err = errResponse("type_mismatch", "argument " + std::to_string(index) +
                                             " is null, but the parameter is not a pointer");
      return false;
    }
    out.kind = Arg::Kind::Null;
    return true;
  }

  if (*kind == "bytes") {
    if (!paramTy->isPointerTy()) {
      err = errResponse("type_mismatch", "argument " + std::to_string(index) +
                                             " is bytes, but the parameter is not a pointer");
      return false;
    }
    const auto *bytes = spec.getArray("bytes");
    if (!bytes || bytes->empty()) {
      err = errResponse("bad_request", "a bytes argument needs a non-empty 'bytes'");
      return false;
    }
    if (!readBytes(*bytes, out.bytes, err))
      return false;
    auto align = spec.getInteger("align").value_or(1);
    if (align <= 0 || !llvm::isPowerOf2_64((uint64_t)align)) {
      err = errResponse("invalid", "align must be a positive power of two");
      return false;
    }
    out.kind = Arg::Kind::Bytes;
    out.align = (uint64_t)align;
    return true;
  }

  if (*kind == "poison") {
    if (auto attr = poisonUB(param)) {
      err = errResponse("invalid", "argument " + std::to_string(index) + " is poison, but under " +
                                       llvm::Attribute::getNameFromAttrKind(*attr).str() +
                                       " a poison argument is undefined behavior");
      return false;
    }
    out.kind = Arg::Kind::Poison;
    return true;
  }

  err = errResponse("invalid", "unknown argument kind '" + kind->str() + "'");
  return false;
}

} // namespace

bool readArgs(const llvm::Function &F, const llvm::json::Array &spec, std::vector<Arg> &out,
              llvm::json::Object &err) {
  if (F.arg_size() != spec.size()) {
    err = errResponse("bad_request", "'@" + F.getName().str() + "' takes " +
                                         std::to_string(F.arg_size()) + " arguments, but " +
                                         std::to_string(spec.size()) + " were given");
    return false;
  }
  for (unsigned i = 0; i < F.arg_size(); ++i) {
    const auto *one = spec[i].getAsObject();
    if (!one) {
      err = errResponse("bad_request", "each argument must be an object");
      return false;
    }
    Arg arg;
    if (!readArg(*F.getArg(i), *one, arg, err))
      return false;
    out.push_back(std::move(arg));
  }
  return true;
}

} // namespace llops
