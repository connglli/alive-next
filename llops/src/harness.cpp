#include "harness.h"

#include "input.h"
#include "irutil.h"

#include "llvm/IR/Constants.h"
#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/Support/ModRef.h"
#include <string>
#include <utility>
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

// Build the value for one parameter, allocating and filling memory when the
// parameter is a pointer.
Argument buildArgument(llvm::IRBuilder<> &builder, llvm::Type *paramTy, const Arg &arg,
                       unsigned index) {
  Argument out;
  if (arg.kind == Arg::Kind::Int) {
    out.value = llvm::ConstantInt::get(paramTy->getContext(), arg.value);
    return out;
  }
  if (arg.kind == Arg::Kind::Null) {
    out.value = llvm::ConstantPointerNull::get(llvm::cast<llvm::PointerType>(paramTy));
    return out;
  }
  if (arg.kind == Arg::Kind::Poison) {
    out.value = llvm::PoisonValue::get(paramTy);
    return out;
  }
  llvm::LLVMContext &ctx = paramTy->getContext();
  auto *arrayTy = llvm::ArrayType::get(llvm::Type::getInt8Ty(ctx), arg.bytes.size());
  auto *buffer = builder.CreateAlloca(arrayTy, nullptr, "buf" + std::to_string(index));
  buffer->setAlignment(llvm::Align(arg.align));
  // One store of the whole initial content, so the harness reads as what it
  // is: this memory starts out holding these bytes.
  builder.CreateStore(llvm::ConstantDataArray::get(ctx, arg.bytes), buffer);
  out.value = buffer;
  out.buffer = buffer;
  out.size = arg.bytes.size();
  return out;
}

// What in `F` llubi does not treat as alive2 does (docs/semantics.md), so that
// a run of it as the src could show what alive2 does not allow.
llvm::json::Array differences(const llvm::Function &F) {
  bool freezes = false, calls = false, addresses = false;
  bool writeonly = false, captures = false, initializes = false;
  for (const llvm::Instruction &I : llvm::instructions(F)) {
    freezes |= llvm::isa<llvm::FreezeInst>(I);
    calls |= llvm::isa<llvm::CallBase>(I) && I.mayReadOrWriteMemory();
    // A call that returns a pointer may return a fresh allocation.
    bool fresh = llvm::isa<llvm::AllocaInst>(I) ||
                 (llvm::isa<llvm::CallBase>(I) && I.getType()->isPtrOrPtrVectorTy());
    addresses |= fresh && escapingUse(I);
  }
  // llubi lays globals out by the module, so the two programs may place one apart.
  for (const llvm::GlobalVariable &G : F.getParent()->globals())
    addresses |= escapingUse(G) != nullptr;
  for (const llvm::Argument &arg : F.args()) {
    writeonly |= arg.hasAttribute(llvm::Attribute::WriteOnly);
    captures |= arg.hasAttribute(llvm::Attribute::Captures) &&
                llvm::capturesNothing(arg.getAttribute(llvm::Attribute::Captures).getCaptureInfo());
    initializes |= arg.hasAttribute(llvm::Attribute::Initializes);
  }
  bool limited = F.getMemoryEffects() != llvm::MemoryEffects::unknown();
  const std::pair<const char *, bool> kinds[] = {
      {"freeze", freezes},
      {"writeonly", writeonly},
      {"captures(none)", captures},
      {"initializes", initializes},
      {"a call under memory(...)", limited && calls},
      {"an allocation's address", addresses},
  };
  llvm::json::Array found;
  for (auto [name, held] : kinds)
    if (held)
      found.push_back(name);
  return found;
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
  // A run that returns from it would read as defined, since llubi does not check noreturn.
  if (entry->doesNotReturn())
    return errResponse("invalid",
                       "'@" + entryName->str() + "' is noreturn, which llubi does not check");
  if (M.getFunction("main"))
    return errResponse("invalid", "the module already defines '@main'");

  std::vector<Arg> input;
  llvm::json::Object err;
  if (!readArgs(*entry, *spec, input, err))
    return err;

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
    arguments.push_back(buildArgument(builder, entry->getArg(i)->getType(), input[i], i));
    callArgs.push_back(arguments.back().value);
  }

  auto *call = builder.CreateCall(entry, callArgs);
  // llubi applies a parameter's attributes only when the call carries them.
  call->setAttributes(entry->getAttributes().removeFnAttributes(ctx).removeAttributesAtIndex(
      ctx, llvm::AttributeList::ReturnIndex));
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
    // alive2 treats the memory behind a dead_on_return parameter as gone after the call.
    if (!argument.buffer || entry->hasParamAttribute(i, llvm::Attribute::DeadOnReturn))
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
  resp["differences"] = differences(*entry);
  return resp;
}

} // namespace llops
