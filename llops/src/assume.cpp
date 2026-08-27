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

llvm::CmpInst::Predicate parseICmpPred(llvm::StringRef op) {
  if (op == "eq")
    return llvm::CmpInst::ICMP_EQ;
  if (op == "ne")
    return llvm::CmpInst::ICMP_NE;
  if (op == "ugt")
    return llvm::CmpInst::ICMP_UGT;
  if (op == "uge")
    return llvm::CmpInst::ICMP_UGE;
  if (op == "ult")
    return llvm::CmpInst::ICMP_ULT;
  if (op == "ule")
    return llvm::CmpInst::ICMP_ULE;
  if (op == "sgt")
    return llvm::CmpInst::ICMP_SGT;
  if (op == "sge")
    return llvm::CmpInst::ICMP_SGE;
  if (op == "slt")
    return llvm::CmpInst::ICMP_SLT;
  if (op == "sle")
    return llvm::CmpInst::ICMP_SLE;
  return llvm::CmpInst::BAD_ICMP_PREDICATE;
}

llvm::Value *resolveOperand(const llvm::json::Value &v, llvm::Function *F, llvm::CallInst *call,
                            ValueRefs &refs, llvm::Type *expectedType, llvm::json::Object &err) {
  if (auto num = v.getAsInteger()) {
    if (expectedType && expectedType->isIntegerTy()) {
      unsigned bits = expectedType->getIntegerBitWidth();
      return llvm::ConstantInt::get(expectedType, llvm::APInt(bits, (uint64_t)*num, true));
    }
  }
  const auto *obj = v.getAsObject();
  if (!obj) {
    err = errResponse("invalid",
                      "predicate operand must be an object (e.g. {\"arg\": 0}, {\"const\": 0})");
    return nullptr;
  }
  if (auto argIdx = obj->getInteger("arg")) {
    if (call) {
      if (*argIdx < 0 || (uint64_t)*argIdx >= call->arg_size()) {
        err = errResponse("invalid", "arg index out of range for call");
        return nullptr;
      }
      return call->getArgOperand((unsigned)*argIdx);
    }
    if (F) {
      if (*argIdx < 0 || (uint64_t)*argIdx >= F->arg_size()) {
        err = errResponse("invalid", "arg index out of range for function");
        return nullptr;
      }
      return F->getArg((unsigned)*argIdx);
    }
    err = errResponse("invalid", "cannot resolve argument without a function or call context");
    return nullptr;
  }
  if (auto valRef = obj->getString("value")) {
    auto *val = refs.resolve(*valRef);
    if (!val) {
      err = errResponse("not_found", "'" + valRef->str() + "' is not a value");
      return nullptr;
    }
    return val;
  }
  if (auto cVal = obj->getInteger("const")) {
    if (expectedType && expectedType->isIntegerTy()) {
      unsigned bits = expectedType->getIntegerBitWidth();
      return llvm::ConstantInt::get(expectedType, llvm::APInt(bits, (uint64_t)*cVal, true));
    }
    if (F) {
      return llvm::ConstantInt::get(llvm::Type::getInt32Ty(F->getContext()), *cVal, true);
    }
  }
  err = errResponse("invalid", "unrecognized predicate operand");
  return nullptr;
}

bool buildPredicate(const llvm::json::Object &predObj, llvm::Function *F, llvm::CallInst *call,
                    ValueRefs &refs, llvm::IRBuilder<> &builder, llvm::Value *&cond,
                    llvm::json::Object &err) {
  auto op = predObj.getString("op");
  auto *lhsJson = predObj.get("lhs");
  auto *rhsJson = predObj.get("rhs");
  if (!op || !lhsJson || !rhsJson) {
    err = errResponse("bad_request", "predicate needs 'op', 'lhs', and 'rhs'");
    return false;
  }
  llvm::CmpInst::Predicate cmpPred = parseICmpPred(*op);
  if (cmpPred == llvm::CmpInst::BAD_ICMP_PREDICATE) {
    err = errResponse("invalid", "unknown predicate operator '" + op->str() + "'");
    return false;
  }

  llvm::Value *lhs = resolveOperand(*lhsJson, F, call, refs, nullptr, err);
  if (!lhs)
    return false;

  llvm::Value *rhs = resolveOperand(*rhsJson, F, call, refs, lhs->getType(), err);
  if (!rhs)
    return false;

  if (lhs->getType() != rhs->getType()) {
    err = errResponse("type_mismatch", "predicate operands must have identical types");
    return false;
  }
  if (!lhs->getType()->isIntegerTy() && !lhs->getType()->isPointerTy()) {
    err = errResponse("invalid", "predicate operands must be integer or pointer types");
    return false;
  }

  llvm::Value *cmp = builder.CreateICmp(cmpPred, lhs, rhs);
  cond = cond ? builder.CreateAnd(cond, cmp) : cmp;
  return true;
}

} // namespace

llvm::json::Object assumeCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  auto beforeRef = args.getString("before");
  auto valueRef = args.getString("value");
  auto beforeCall = args.getString("before_call");
  auto entryRef = args.getString("entry");
  auto argIndex = args.getInteger("arg");
  auto *facts = args.getObject("fact");
  auto *predicateObj = args.getObject("predicate");
  auto *predicatesArr = args.getArray("predicates");

  if (!text)
    return errResponse("bad_request", "assume needs 'module'");

  const int anchorCount = (beforeRef ? 1 : 0) + (beforeCall ? 1 : 0) + (entryRef ? 1 : 0);
  if (anchorCount != 1) {
    return errResponse("bad_request",
                       "assume takes exactly one anchor: 'before', 'before_call', or 'entry'");
  }

  const bool hasFacts = facts && !facts->empty();
  const bool hasPredicates =
      (predicateObj && !predicateObj->empty()) || (predicatesArr && !predicatesArr->empty());
  if (!hasFacts && !hasPredicates) {
    return errResponse("bad_request", "assume needs at least one fact or predicate");
  }

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);
  llvm::Module &M = *mwc->mod;

  llvm::Function *F = singleFunction(M);
  if (!F)
    return errResponse("shape_error", "assume needs the v1 shape: exactly one defined function");
  llvm::BasicBlock *BB = singleBlock(*F);
  if (!BB)
    return errResponse("shape_error", "assume needs a single basic block");
  ValueRefs refs(*F);
  llvm::Instruction *before = nullptr;
  llvm::Value *value = nullptr;
  llvm::CallInst *call = nullptr;

  if (beforeRef) {
    before = refs.resolveInst(*beforeRef);
    if (!before)
      return errResponse("not_found", "'" + beforeRef->str() + "' is not an instruction");
    if (hasFacts) {
      if (!valueRef)
        return errResponse("bad_request", "assume with 'before' and 'fact' needs 'value'");
      value = refs.resolve(*valueRef);
      if (!value)
        return errResponse("not_found", "'" + valueRef->str() + "' is not a value");
    }
  } else if (beforeCall) {
    for (auto &I : *BB) {
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
    before = call;
    if (hasFacts) {
      if (!argIndex)
        return errResponse("bad_request", "assume with 'before_call' and 'fact' needs 'arg'");
      if (*argIndex < 0 || (uint64_t)*argIndex >= call->arg_size()) {
        return errResponse("invalid", "'@" + beforeCall->str() + "' is called with " +
                                          std::to_string(call->arg_size()) + " arguments");
      }
      value = call->getArgOperand((unsigned)*argIndex);
    }
  } else if (entryRef) {
    if (F->getName() != *entryRef) {
      return errResponse("not_found", "no function defined with name '@" + entryRef->str() + "'");
    }
    before = &*BB->begin();
    if (hasFacts) {
      if (!argIndex)
        return errResponse("bad_request", "assume with 'entry' and 'fact' needs 'arg'");
      if (*argIndex < 0 || (uint64_t)*argIndex >= F->arg_size()) {
        return errResponse("invalid", "'@" + entryRef->str() + "' has " +
                                          std::to_string(F->arg_size()) + " arguments");
      }
      value = F->getArg((unsigned)*argIndex);
    }
  }

  llvm::LLVMContext &ctx = M.getContext();
  llvm::IRBuilder<> builder(before);
  auto *i64 = llvm::Type::getInt64Ty(ctx);
  llvm::Value *condition = nullptr;
  std::vector<llvm::OperandBundleDef> bundles;

  auto conjoin = [&](llvm::Value *next) {
    condition = condition ? builder.CreateAnd(condition, next) : next;
  };

  if (hasFacts) {
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
        llvm::Value *low = builder.CreateICmpSGE(value, llvm::ConstantInt::get(ctx, min));
        llvm::Value *high = builder.CreateICmpSLT(value, llvm::ConstantInt::get(ctx, max));
        conjoin(min.slt(max) ? builder.CreateAnd(low, high) : builder.CreateOr(low, high));
        continue;
      }

      if (kind == "noundef") {
        bundles.emplace_back("noundef", llvm::ArrayRef<llvm::Value *>{value});
        continue;
      }

      if (kind == "nonnull") {
        if (!value->getType()->isPointerTy())
          return errResponse("invalid", "'nonnull' applies to a pointer");
        bundles.emplace_back("nonnull", llvm::ArrayRef<llvm::Value *>{value});
        continue;
      }
      if (kind == "align" || kind == "dereferenceable") {
        if (!value->getType()->isPointerTy())
          return errResponse("invalid", "'" + kind.str() + "' applies to a pointer");
        uint64_t bytes = 0;
        if (!positive(spec, kind == "align", kind, bytes, err))
          return err;
        bundles.emplace_back(
            kind.str(), llvm::ArrayRef<llvm::Value *>{value, llvm::ConstantInt::get(i64, bytes)});
        continue;
      }
      if (kind == "noalias") {
        return errResponse("invalid", "noalias cannot be stated as an assume");
      }
      return errResponse("invalid", "unknown fact '" + kind.str() + "'");
    }
  }

  if (predicateObj && !predicateObj->empty()) {
    llvm::json::Object err;
    if (!buildPredicate(*predicateObj, F, call, refs, builder, condition, err))
      return err;
  }
  if (predicatesArr) {
    for (const auto &pVal : *predicatesArr) {
      const auto *pObj = pVal.getAsObject();
      if (!pObj)
        return errResponse("bad_request", "each predicate must be an object");
      llvm::json::Object err;
      if (!buildPredicate(*pObj, F, call, refs, builder, condition, err))
        return err;
    }
  }

  if (condition)
    builder.CreateAssumption(condition);
  if (!bundles.empty() || (!condition && hasFacts))
    builder.CreateAssumption(builder.getTrue(), bundles);

  auto diags = checkFunction(*F);
  if (diags.empty())
    diags = checkModule(M);
  if (!diags.empty())
    return errResponse(diags.front().code, diags.front().message);
  return moduleResponse(M);
}

} // namespace llops
