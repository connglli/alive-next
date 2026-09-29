#include "assume.h"

#include "irutil.h"

#include "llvm/IR/Constants.h"
#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/InstIterator.h"
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

// Where the assumes go, and the parameters `arg` n picks from; before_inst has none.
struct Site {
  llvm::Instruction *before;
  std::optional<std::vector<llvm::Value *>> params;
};

llvm::Value *param(const Site &site, int64_t index, llvm::json::Object &err) {
  if (!site.params) {
    err = errResponse("bad_request", "'arg' is refused at before_inst; name the value with 'val'");
    return nullptr;
  }
  if (index < 0 || (uint64_t)index >= site.params->size()) {
    err = errResponse("invalid", "arg " + std::to_string(index) + " is out of range");
    return nullptr;
  }
  return (*site.params)[index];
}

llvm::Value *local(const Site &site, llvm::StringRef ref, ValueRefs &refs,
                   llvm::json::Object &err) {
  if (site.params) {
    err =
        errResponse("bad_request", "'val' is only for before_inst; name the parameter with 'arg'");
    return nullptr;
  }
  llvm::Value *value = refs.resolve(ref);
  if (!value)
    err = errResponse("not_found", "'" + ref.str() + "' is not a value");
  return value;
}

llvm::Value *resolveOperand(const llvm::json::Value &v, const Site &site, ValueRefs &refs,
                            llvm::Type *expectedType, llvm::json::Object &err) {
  const auto *obj = v.getAsObject();
  if (!obj) {
    err = errResponse("invalid",
                      "predicate operand must be an object (e.g. {\"arg\": 0}, {\"const\": 0})");
    return nullptr;
  }
  if (auto index = obj->getInteger("arg"))
    return param(site, *index, err);
  if (auto ref = obj->getString("val"))
    return local(site, *ref, refs, err);
  if (auto cVal = obj->getInteger("const")) {
    if (expectedType && expectedType->isIntegerTy()) {
      unsigned bits = expectedType->getIntegerBitWidth();
      return llvm::ConstantInt::get(expectedType, llvm::APInt(bits, (uint64_t)*cVal, true));
    }
    return llvm::ConstantInt::get(llvm::Type::getInt32Ty(site.before->getContext()), *cVal, true);
  }
  err = errResponse("invalid", "unrecognized predicate operand");
  return nullptr;
}

bool buildPredicate(const llvm::json::Object &predObj, const Site &site, ValueRefs &refs,
                    llvm::IRBuilder<> &builder, llvm::Value *&cond, llvm::json::Object &err) {
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

  llvm::Value *lhs = resolveOperand(*lhsJson, site, refs, nullptr, err);
  if (!lhs)
    return false;

  llvm::Value *rhs = resolveOperand(*rhsJson, site, refs, lhs->getType(), err);
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

bool applyAssertion(const llvm::json::Object &item, const Site &site, ValueRefs &refs,
                    llvm::IRBuilder<> &builder, llvm::Value *&condition,
                    std::vector<llvm::OperandBundleDef> &bundles, llvm::json::Object &err) {
  llvm::LLVMContext &ctx = builder.getContext();
  auto *facts = item.getObject("fact");
  auto op = item.getString("op");

  if (facts) {
    if (facts->empty()) {
      err = errResponse("bad_request", "fact object cannot be empty");
      return false;
    }
    auto index = item.getInteger("arg");
    auto ref = item.getString("val");
    if (!index && !ref) {
      err = errResponse("bad_request", "fact assertion needs 'arg' or 'val'");
      return false;
    }
    llvm::Value *value = index ? param(site, *index, err) : local(site, *ref, refs, err);
    if (!value)
      return false;

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

  if (op.has_value())
    return buildPredicate(item, site, refs, builder, condition, err);

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
                       "anchor needs 'at' ('start', 'before_call', or 'before_inst')");

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);
  llvm::Module &M = *mwc->mod;

  llvm::Function *F = singleFunction(M);
  if (!F)
    return errResponse("shape_error",
                       "assume needs the program shape: exactly one defined function");
  ValueRefs refs(*F);
  Site site{nullptr, std::nullopt};

  if (*at == "start") {
    auto fnName = anchorObj->getString("fn");
    if (!fnName)
      return errResponse("bad_request", "anchor with at 'start' needs 'fn'");
    if (F->getName() != *fnName)
      return errResponse("not_found", "no function defined with name '@" + fnName->str() + "'");
    std::vector<llvm::Value *> params;
    for (llvm::Argument &arg : F->args())
      params.push_back(&arg);
    site = {&*F->getEntryBlock().getFirstInsertionPt(), params};
  } else if (*at == "before_call") {
    auto fnName = anchorObj->getString("fn");
    if (!fnName)
      return errResponse("bad_request", "anchor with at 'before_call' needs 'fn'");
    llvm::CallInst *call = nullptr;
    for (auto &I : llvm::instructions(*F)) {
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
    site = {call, std::vector<llvm::Value *>(call->arg_begin(), call->arg_end())};
  } else if (*at == "before_inst") {
    auto instRef = anchorObj->getString("inst");
    if (!instRef)
      return errResponse("bad_request", "anchor with at 'before_inst' needs 'inst'");
    llvm::Instruction *inst = refs.resolveInst(*instRef);
    if (!inst)
      return errResponse("not_found", "'" + instRef->str() + "' is not an instruction");
    site = {inst, std::nullopt};
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

  llvm::IRBuilder<> builder(site.before);
  llvm::Value *condition = nullptr;
  std::vector<llvm::OperandBundleDef> bundles;

  for (const auto *item : items) {
    llvm::json::Object err;
    if (!applyAssertion(*item, site, refs, builder, condition, bundles, err))
      return err;
  }

  if (condition)
    builder.CreateAssumption(condition);
  if (!bundles.empty())
    builder.CreateAssumption(builder.getTrue(), bundles);

  return checkedResponse(M);
}

} // namespace llops
