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
  if (auto valRef = obj->getString("val")) {
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

bool applyAssertion(const llvm::json::Object &item, llvm::Function *F, llvm::CallInst *call,
                    ValueRefs &refs, llvm::LLVMContext &ctx, llvm::IRBuilder<> &builder,
                    llvm::Value *&condition, std::vector<llvm::OperandBundleDef> &bundles,
                    llvm::json::Object &err) {
  auto *facts = item.getObject("fact");
  auto op = item.getString("op");
  auto *predicateObj = item.getObject("predicate");

  if (facts) {
    if (facts->empty()) {
      err = errResponse("bad_request", "fact object cannot be empty");
      return false;
    }
    llvm::Value *value = nullptr;
    auto argIdx = item.getInteger("arg");
    auto valRef = item.getString("val");

    if (argIdx.has_value()) {
      if (call) {
        if (*argIdx < 0 || (uint64_t)*argIdx >= call->arg_size()) {
          err = errResponse("invalid", "arg index out of range for call");
          return false;
        }
        value = call->getArgOperand((unsigned)*argIdx);
      } else if (F) {
        if (*argIdx < 0 || (uint64_t)*argIdx >= F->arg_size()) {
          err = errResponse("invalid", "arg index out of range for function");
          return false;
        }
        value = F->getArg((unsigned)*argIdx);
      } else {
        err = errResponse("bad_request", "arg index cannot be used with before_inst; use 'val'");
        return false;
      }
    } else if (valRef.has_value()) {
      value = refs.resolve(*valRef);
      if (!value) {
        err = errResponse("not_found", "'" + valRef->str() + "' is not a value");
        return false;
      }
    } else {
      err = errResponse("bad_request", "fact assertion needs 'arg' or 'val'");
      return false;
    }

    auto *i64 = llvm::Type::getInt64Ty(ctx);
    auto conjoin = [&](llvm::Value *next) {
      condition = condition ? builder.CreateAnd(condition, next) : next;
    };

    for (const auto &entry : *facts) {
      llvm::StringRef kind = entry.first;
      const llvm::json::Value &spec = entry.second;

      if (kind == "range") {
        const auto *range = spec.getAsObject();
        if (!range || !value->getType()->isIntegerTy()) {
          err = errResponse("invalid", "range needs {min, max} and an integer value");
          return false;
        }
        unsigned bits = value->getType()->getIntegerBitWidth();
        llvm::APInt min(bits, 0), max(bits, 0);
        if (!bound(*range, "min", bits, min, err) || !bound(*range, "max", bits, max, err))
          return false;
        if (min == max) {
          err = errResponse("invalid", "range must be a non-empty half-open interval");
          return false;
        }
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
        if (!value->getType()->isPointerTy()) {
          err = errResponse("invalid", "'nonnull' applies to a pointer");
          return false;
        }
        bundles.emplace_back("nonnull", llvm::ArrayRef<llvm::Value *>{value});
        continue;
      }
      if (kind == "align" || kind == "dereferenceable") {
        if (!value->getType()->isPointerTy()) {
          err = errResponse("invalid", "'" + kind.str() + "' applies to a pointer");
          return false;
        }
        uint64_t bytes = 0;
        if (!positive(spec, kind == "align", kind, bytes, err))
          return false;
        bundles.emplace_back(
            kind.str(), llvm::ArrayRef<llvm::Value *>{value, llvm::ConstantInt::get(i64, bytes)});
        continue;
      }
      if (kind == "noalias") {
        err = errResponse("invalid", "noalias cannot be stated as an assume");
        return false;
      }
      err = errResponse("invalid", "unknown fact '" + kind.str() + "'");
      return false;
    }
    return true;
  }

  if (op.has_value()) {
    return buildPredicate(item, F, call, refs, builder, condition, err);
  }
  if (predicateObj) {
    return buildPredicate(*predicateObj, F, call, refs, builder, condition, err);
  }

  err = errResponse("bad_request", "assertion must specify 'fact' or 'op'");
  return false;
}

} // namespace

llvm::json::Object assumeCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  auto *anchorObj = args.getObject("anchor");
  if (!text || !anchorObj)
    return errResponse("bad_request", "assume needs 'module' and 'anchor'");

  auto at = anchorObj->getString("at");
  if (!at)
    return errResponse("bad_request",
                       "anchor needs 'at' ('entry', 'before_call', or 'before_inst')");

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
  llvm::CallInst *call = nullptr;

  if (*at == "entry") {
    auto fnName = anchorObj->getString("fn");
    if (!fnName)
      return errResponse("bad_request", "anchor with at 'entry' needs 'fn'");
    if (F->getName() != *fnName)
      return errResponse("not_found", "no function defined with name '@" + fnName->str() + "'");
    before = &*BB->begin();
  } else if (*at == "before_call") {
    auto fnName = anchorObj->getString("fn");
    if (!fnName)
      return errResponse("bad_request", "anchor with at 'before_call' needs 'fn'");
    for (auto &I : *BB) {
      auto *candidate = llvm::dyn_cast<llvm::CallInst>(&I);
      if (!candidate || !candidate->getCalledFunction())
        continue;
      if (candidate->getCalledFunction()->getName() != *fnName)
        continue;
      if (call)
        return errResponse("invalid", "more than one call to '@" + fnName->str() + "'");
      call = candidate;
    }
    if (!call)
      return errResponse("not_found", "no call to '@" + fnName->str() + "'");
    before = call;
  } else if (*at == "before_inst") {
    auto instRef = anchorObj->getString("inst");
    if (!instRef)
      return errResponse("bad_request", "anchor with at 'before_inst' needs 'inst'");
    before = refs.resolveInst(*instRef);
    if (!before)
      return errResponse("not_found", "'" + instRef->str() + "' is not an instruction");
  } else {
    return errResponse("bad_request", "unknown anchor at '" + at->str() + "'");
  }

  auto *arr = args.getArray("assertions");
  if (!arr || arr->empty())
    return errResponse("bad_request", "assume needs non-empty 'assertions' array");

  std::vector<const llvm::json::Object *> items;
  for (const auto &val : *arr) {
    const auto *obj = val.getAsObject();
    if (!obj)
      return errResponse("bad_request", "each assertion in 'assertions' must be an object");
    items.push_back(obj);
  }

  llvm::LLVMContext &ctx = M.getContext();
  llvm::IRBuilder<> builder(before);
  llvm::Value *condition = nullptr;
  std::vector<llvm::OperandBundleDef> bundles;

  for (const auto *item : items) {
    llvm::json::Object err;
    if (!applyAssertion(*item, F, call, refs, ctx, builder, condition, bundles, err))
      return err;
  }

  if (condition)
    builder.CreateAssumption(condition);
  if (!bundles.empty())
    builder.CreateAssumption(builder.getTrue(), bundles);

  auto diags = checkFunction(*F);
  if (diags.empty())
    diags = checkModule(M);
  if (!diags.empty())
    return errResponse(diags.front().code, diags.front().message);
  return moduleResponse(M);
}

} // namespace llops
