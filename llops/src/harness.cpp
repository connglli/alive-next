#include "harness.h"

#include "irutil.h"

#include "llvm/IR/Constants.h"
#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/Instructions.h"
#include "llvm/Support/raw_ostream.h"
#include <string>
#include <vector>

namespace llops {

namespace {

/** One parameter's value, and the buffer behind it when it is a pointer. */
struct Argument {
  llvm::Value *value = nullptr;
  /** Set for a pointer argument, so its bytes can be read back afterwards. */
  llvm::AllocaInst *buffer = nullptr;
  uint64_t size = 0;
};

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

// Build the value for one parameter, allocating and filling memory when the
// parameter is a pointer.
bool buildArgument(llvm::IRBuilder<> &builder, llvm::Type *paramTy, const llvm::json::Object &spec,
                   unsigned index, Argument &out, llvm::json::Object &err) {
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
    llvm::APInt parsed(paramTy->getIntegerBitWidth(), 0);
    // The value arrives as text so that a width beyond 64 bits survives JSON.
    if (llvm::StringRef(*text).getAsInteger(0, parsed)) {
      err = errResponse("invalid", "argument " + std::to_string(index) + ": '" + text->str() +
                                       "' is not an integer");
      return false;
    }
    out.value = llvm::ConstantInt::get(paramTy->getContext(), parsed);
    return true;
  }

  if (*kind == "null") {
    if (!paramTy->isPointerTy()) {
      err = errResponse("type_mismatch", "argument " + std::to_string(index) +
                                             " is null, but the parameter is not a pointer");
      return false;
    }
    out.value = llvm::ConstantPointerNull::get(llvm::cast<llvm::PointerType>(paramTy));
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
    std::vector<uint8_t> raw;
    if (!readBytes(*bytes, raw, err))
      return false;
    auto align = spec.getInteger("align").value_or(1);
    if (align <= 0 || !llvm::isPowerOf2_64((uint64_t)align)) {
      err = errResponse("invalid", "align must be a positive power of two");
      return false;
    }

    llvm::LLVMContext &ctx = paramTy->getContext();
    auto *arrayTy = llvm::ArrayType::get(llvm::Type::getInt8Ty(ctx), raw.size());
    auto *buffer = builder.CreateAlloca(arrayTy, nullptr, "buf" + std::to_string(index));
    buffer->setAlignment(llvm::Align((uint64_t)align));
    // One store of the whole initial content, so the harness reads as what it
    // is: this memory starts out holding these bytes.
    builder.CreateStore(llvm::ConstantDataArray::get(ctx, raw), buffer);
    out.value = buffer;
    out.buffer = buffer;
    out.size = raw.size();
    return true;
  }

  err = errResponse("invalid", "unknown argument kind '" + kind->str() + "'");
  return false;
}

} // namespace

llvm::json::Object harnessCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  auto entryName = args.getString("entry");
  const auto *spec = args.getArray("args");
  if (!text || !entryName || !spec)
    return errResponse("bad_request", "harness needs 'module', 'entry' and 'args'");

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);
  llvm::Module &M = *mwc->mod;

  llvm::Function *entry = M.getFunction(*entryName);
  if (!entry || entry->isDeclaration())
    return errResponse("not_found", "'@" + entryName->str() + "' is not defined in the module");
  if (M.getFunction("main"))
    return errResponse("invalid", "the module already defines '@main'");
  if (entry->arg_size() != spec->size()) {
    return errResponse("bad_request", "'@" + entryName->str() + "' takes " +
                                          std::to_string(entry->arg_size()) + " arguments, but " +
                                          std::to_string(spec->size()) + " were given");
  }

  llvm::LLVMContext &ctx = M.getContext();
  auto *i32 = llvm::Type::getInt32Ty(ctx);
  auto *i8 = llvm::Type::getInt8Ty(ctx);
  auto *ptr = llvm::PointerType::getUnqual(ctx);
  // llubi refuses any other signature.
  auto *mainTy = llvm::FunctionType::get(i32, {i32, ptr}, false);
  auto *main = llvm::Function::Create(mainTy, llvm::Function::ExternalLinkage, "main", &M);
  llvm::IRBuilder<> builder(llvm::BasicBlock::Create(ctx, "entry", main));

  std::vector<Argument> arguments;
  std::vector<llvm::Value *> callArgs;
  for (unsigned i = 0; i < entry->arg_size(); ++i) {
    const auto *one = (*spec)[i].getAsObject();
    if (!one)
      return errResponse("bad_request", "each argument must be an object");
    Argument argument;
    llvm::json::Object err;
    if (!buildArgument(builder, entry->getArg(i)->getType(), *one, i, argument, err))
      return err;
    arguments.push_back(argument);
    callArgs.push_back(argument.value);
  }

  auto *call = builder.CreateCall(entry, callArgs);
  llvm::json::Array observations;

  // The return value goes to memory and back, so that it is observed the same
  // way the final bytes are: one trace line naming what it is.
  if (!entry->getReturnType()->isVoidTy()) {
    auto *slot = builder.CreateAlloca(entry->getReturnType(), nullptr, "result.slot");
    builder.CreateStore(call, slot);
    builder.CreateLoad(entry->getReturnType(), slot, "obs.result");
    observations.push_back("%obs.result");
  }

  // What a pointer argument's memory holds after the call is the other half of
  // the behaviour worth comparing, read back a byte at a time.
  for (unsigned i = 0; i < arguments.size(); ++i) {
    const Argument &argument = arguments[i];
    if (!argument.buffer)
      continue;
    for (uint64_t offset = 0; offset < argument.size; ++offset) {
      auto *at = builder.CreateConstInBoundsGEP1_64(i8, argument.buffer, offset);
      std::string name = "obs.mem." + std::to_string(i) + "." + std::to_string(offset);
      builder.CreateLoad(i8, at, name);
      observations.push_back("%" + name);
    }
  }

  // main returns nothing of interest: the exit code is eight bits wide, and
  // everything worth reading is in the trace.
  builder.CreateRet(llvm::ConstantInt::get(i32, 0));

  auto diags = checkModule(M);
  if (!diags.empty())
    return errResponse(diags.front().code, diags.front().message);

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["module"] = printModule(M);
  resp["observations"] = std::move(observations);
  return resp;
}

} // namespace llops
