#include "assume.h"

#include "irutil.h"

#include "llvm/IR/Constants.h"
#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/Instructions.h"
#include <string>
#include <vector>

namespace llops {

namespace {

/** An integer bound from the request, checked against the value's width. */
bool bound(const llvm::json::Object &range, llvm::StringRef key, unsigned bits, llvm::APInt &out,
           llvm::json::Object &err) {
  auto value = range.getInteger(key);
  if (!value) {
    err = errResponse("invalid", "range needs " + key.str());
    return false;
  }
  if (bits < 64 && !llvm::isIntN(bits, *value)) {
    err = errResponse("invalid", "range bound " + key.str() + " does not fit the value's type");
    return false;
  }
  out = llvm::APInt(bits, (uint64_t)*value, true);
  return true;
}

/** A positive power of two, for align, or a positive count, for the rest. */
bool positive(const llvm::json::Value &value, bool powerOfTwo, llvm::StringRef what, uint64_t &out,
              llvm::json::Object &err) {
  auto number = value.getAsInteger();
  if (!number || *number <= 0 || (powerOfTwo && !llvm::isPowerOf2_64((uint64_t)*number))) {
    err = errResponse("invalid", what.str() + " must be a positive" +
                                     (powerOfTwo ? " power of two" : " number"));
    return false;
  }
  out = (uint64_t)*number;
  return true;
}

} // namespace

llvm::json::Object assumeCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  auto beforeRef = args.getString("before");
  auto valueRef = args.getString("value");
  auto beforeCall = args.getString("before_call");
  auto argIndex = args.getInteger("arg");
  auto *facts = args.getObject("fact");
  if (!text || !facts)
    return errResponse("bad_request", "assume needs 'module' and 'fact'");
  const bool byRef = beforeRef && valueRef;
  const bool byCall = beforeCall && argIndex;
  if (byRef == byCall) {
    return errResponse("bad_request", "assume takes either 'before' with 'value', or "
                                      "'before_call' with 'arg'");
  }
  if (facts->empty())
    return errResponse("bad_request", "assume needs at least one fact");

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);
  llvm::Module &M = *mwc->mod;

  llvm::Function *F = singleFunction(M);
  if (!F)
    return errResponse("shape_error", "assume needs the v1 shape: exactly one defined function");
  ValueRefs refs(*F);
  llvm::Instruction *before = nullptr;
  llvm::Value *value = nullptr;
  if (byRef) {
    before = refs.resolveInst(*beforeRef);
    if (!before)
      return errResponse("not_found", "'" + beforeRef->str() + "' is not an instruction");
    value = refs.resolve(*valueRef);
    if (!value)
      return errResponse("not_found", "'" + valueRef->str() + "' is not a value");
  } else {
    // Anchoring on the call is what strengthening needs, because the fact is
    // about what a call passes and the refs around it move with every edit.
    llvm::CallInst *call = nullptr;
    for (auto &I : *singleBlock(*F)) {
      auto *candidate = llvm::dyn_cast<llvm::CallInst>(&I);
      if (!candidate || !candidate->getCalledFunction())
        continue;
      if (candidate->getCalledFunction()->getName() != *beforeCall)
        continue;
      if (call)
        return errResponse("invalid", "more than one call to '@" + beforeCall->str() + "'");
      call = candidate;
    }
    if (!call)
      return errResponse("not_found", "no call to '@" + beforeCall->str() + "'");
    if (*argIndex < 0 || (uint64_t)*argIndex >= call->arg_size()) {
      return errResponse("invalid", "'@" + beforeCall->str() + "' is called with " +
                                        std::to_string(call->arg_size()) + " arguments");
    }
    before = call;
    value = call->getArgOperand((unsigned)*argIndex);
  }

  llvm::LLVMContext &ctx = M.getContext();
  llvm::IRBuilder<> builder(before);
  auto *i64 = llvm::Type::getInt64Ty(ctx);
  llvm::Value *condition = nullptr;
  std::vector<llvm::OperandBundleDef> bundles;

  auto conjoin = [&](llvm::Value *next) {
    condition = condition ? builder.CreateAnd(condition, next) : next;
  };

  for (const auto &entry : *facts) {
    llvm::StringRef kind = entry.first;
    const llvm::json::Value &spec = entry.second;
    llvm::json::Object err;

    if (kind == "range") {
      const auto *range = spec.getAsObject();
      if (!range || !value->getType()->isIntegerTy())
        return errResponse("invalid", "range needs {min, max} and an integer value");
      unsigned bits = value->getType()->getIntegerBitWidth();
      llvm::APInt min(bits, 0), max(bits, 0);
      if (!bound(*range, "min", bits, min, err) || !bound(*range, "max", bits, max, err))
        return err;
      if (min == max)
        return errResponse("invalid", "range must be a non-empty half-open interval");
      // The attribute's interval is half-open and may wrap, so the predicate
      // is written the same way round: inside [min, max).
      llvm::Value *low = builder.CreateICmpSGE(value, llvm::ConstantInt::get(ctx, min));
      llvm::Value *high = builder.CreateICmpSLT(value, llvm::ConstantInt::get(ctx, max));
      conjoin(min.slt(max) ? builder.CreateAnd(low, high) : builder.CreateOr(low, high));
      continue;
    }

    if (kind == "noundef") {
      // An assume whose condition is poison is immediate UB, and comparing a
      // value with itself is poison exactly when the value is, so this says
      // the value is neither undef nor poison.
      conjoin(builder.CreateICmpEQ(value, value));
      continue;
    }

    if (!value->getType()->isPointerTy())
      return errResponse("invalid", "'" + kind.str() + "' applies to a pointer");

    if (kind == "nonnull") {
      bundles.emplace_back("nonnull", llvm::ArrayRef<llvm::Value *>{value});
      continue;
    }
    if (kind == "align" || kind == "dereferenceable") {
      uint64_t bytes = 0;
      if (!positive(spec, kind == "align", kind, bytes, err))
        return err;
      bundles.emplace_back(
          kind.str(), llvm::ArrayRef<llvm::Value *>{value, llvm::ConstantInt::get(i64, bytes)});
      continue;
    }
    if (kind == "noalias") {
      // noalias is about a function's whole argument list rather than a value
      // at a point, so there is nothing here that would prove it.
      return errResponse("invalid", "noalias cannot be stated as an assume");
    }
    return errResponse("invalid", "unknown fact '" + kind.str() + "'");
  }

  builder.CreateAssumption(condition ? condition : builder.getTrue(), bundles);

  auto diags = checkFunction(*F);
  if (diags.empty())
    diags = checkModule(M);
  if (!diags.empty())
    return errResponse(diags.front().code, diags.front().message);
  return moduleResponse(M);
}

} // namespace llops
