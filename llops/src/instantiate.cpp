#include "instantiate.h"

#include "input.h"
#include "irutil.h"

#include "llvm/IR/IRBuilder.h"
#include "llvm/Support/ModRef.h"
#include "llvm/Support/raw_ostream.h"

#include <string>
#include <vector>

namespace llops {

namespace {

// Whether `F` may read what parameter `k` points to, since a read it forbids is UB.
bool mayRead(const llvm::Function &F, unsigned k) {
  for (auto kind :
       {llvm::Attribute::ReadNone, llvm::Attribute::WriteOnly, llvm::Attribute::Initializes})
    if (F.hasParamAttribute(k, kind))
      return false;
  return llvm::isRefSet(F.getMemoryEffects().getModRef(llvm::IRMemLocation::ArgMem));
}

// The parameter types as text, since the two programs live in different contexts.
std::string paramsText(const llvm::Function &F) {
  std::string text;
  llvm::raw_string_ostream os(text);
  for (const llvm::Argument &arg : F.args())
    os << *arg.getType() << ", ";
  return text;
}

// Assume `input` at the entry of `F`, reading only the pointers `read` marks.
void assumeInput(llvm::Function &F, const std::vector<Arg> &input, const std::vector<bool> &read) {
  llvm::IRBuilder<> b(&*F.getEntryBlock().getFirstInsertionPt());
  for (unsigned k = 0; k < F.arg_size(); ++k) {
    llvm::Argument *param = F.getArg(k);
    const Arg &arg = input[k];
    if (arg.kind == Arg::Kind::Int) {
      auto *value = llvm::ConstantInt::get(param->getType(), arg.value);
      b.CreateAssumption(b.CreateICmpEQ(param, value));
    } else if (arg.kind == Arg::Kind::Null) {
      b.CreateAssumption(b.CreateIsNull(param));
    } else if (read[k]) {
      for (uint64_t at = 0; at < arg.bytes.size(); ++at) {
        auto *byte =
            b.CreateLoad(b.getInt8Ty(), b.CreateConstInBoundsGEP1_64(b.getInt8Ty(), param, at));
        b.CreateAssumption(b.CreateICmpEQ(byte, b.getInt8(arg.bytes[at])));
      }
    }
  }
}

} // namespace

llvm::json::Object instantiateCmd(llvm::json::Object &args) {
  auto srcText = args.getString("src");
  auto tgtText = args.getString("tgt");
  const auto *spec = args.getArray("args");
  if (!srcText || !tgtText || !spec)
    return errResponse("bad_request", "instantiate needs 'src', 'tgt' and 'args'");
  std::string parseErr;
  auto src = parseModule(*srcText, &parseErr);
  if (!src)
    return errResponse("parse_error", "src: " + parseErr);
  auto tgt = parseModule(*tgtText, &parseErr);
  if (!tgt)
    return errResponse("parse_error", "tgt: " + parseErr);
  llvm::Function *srcF = singleFunction(*src->mod);
  llvm::Function *tgtF = singleFunction(*tgt->mod);
  if (!srcF || !tgtF)
    return errResponse("shape_error", "instantiate needs one defined function per module");
  if (paramsText(*srcF) != paramsText(*tgtF))
    return errResponse("type_mismatch", "the two functions take different parameters");

  std::vector<Arg> input;
  llvm::json::Object err;
  if (!readArgs(*srcF, *spec, input, err))
    return err;
  // Both programs get the same assumptions, so a pointer's bytes are read
  // only where neither function forbids it.
  std::vector<bool> read;
  for (unsigned k = 0; k < srcF->arg_size(); ++k)
    read.push_back(mayRead(*srcF, k) && mayRead(*tgtF, k));
  assumeInput(*srcF, input, read);
  assumeInput(*tgtF, input, read);

  for (auto *M : {src->mod.get(), tgt->mod.get()})
    if (auto diags = checkModule(*M); !diags.empty())
      return errResponse(diags.front().code, diags.front().message);
  llvm::json::Object resp;
  resp["ok"] = true;
  resp["src"] = printModule(*src->mod);
  resp["tgt"] = printModule(*tgt->mod);
  return resp;
}

} // namespace llops
