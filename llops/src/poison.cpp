#include "poison.h"

#include "attrs.h"
#include "irutil.h"

#include "llvm/IR/BasicBlock.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/Instructions.h"
#include "llvm/Support/raw_ostream.h"

#include <string>

namespace llops {

namespace {

// The type as it prints, for a refusal to name.
std::string typeName(const llvm::Type &T) {
  std::string text;
  llvm::raw_string_ostream os(text);
  T.print(os);
  return text;
}

// Replace the body of `F` with one block that is undefined behavior at once.
void undefinedFromStart(llvm::Function &F) {
  F.dropAllReferences();
  while (!F.empty())
    F.begin()->eraseFromParent();
  auto *entry = llvm::BasicBlock::Create(F.getContext(), "entry", &F);
  new llvm::UnreachableInst(F.getContext(), entry);
}

} // namespace

llvm::json::Object poisonCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  auto param = args.getInteger("param");
  if (!text || !param)
    return errResponse("bad_request", "poison needs 'module' and 'param'");
  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);
  llvm::Function *F = singleFunction(*mwc->mod);
  if (!F)
    return errResponse("shape_error",
                       "poison needs the program shape: exactly one defined function");
  if (*param < 0 || *param >= (int64_t)F->arg_size())
    return errResponse("not_found",
                       "'@" + F->getName().str() + "' has no parameter " + std::to_string(*param));
  llvm::Argument *arg = F->getArg(*param);

  // A vector or an aggregate may be poison in part, which neither case of a
  // proof covers.
  llvm::Type *type = arg->getType();
  if (!type->isIntegerTy() && !type->isPointerTy() && !type->isFloatingPointTy())
    return errResponse("invalid",
                       "a parameter of type " + typeName(*type) + " may be poison in part");
  if (auto attr = poisonUB(*arg)) {
    // allocsize makes a poison size undefined behavior only where the function
    // returns, which no body says as a whole.
    if (*attr == llvm::Attribute::AllocSize)
      return errResponse("invalid", "allocsize names the parameter, so poison there is "
                                    "undefined behavior only where the function returns");
    // Under the other attributes, a poison argument is undefined behavior at once.
    undefinedFromStart(*F);
  } else {
    arg->replaceAllUsesWith(llvm::PoisonValue::get(type));
  }
  return checkedResponse(*mwc->mod);
}

} // namespace llops
