#include "assume.h"

#include "irutil.h"
#include "snippet.h"

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

// Where an assumption goes, and what it may name there: `!N` for argument N
// in `args`, when there are arguments, and `%x` for a value of the function
// unless `names` is off.
struct Site {
  llvm::Instruction *before = nullptr;
  std::vector<llvm::Value *> args;
  bool hasArgs = false;
  bool names = true;
};

// The value a name stands for at the site.
llvm::Value *resolveName(llvm::StringRef ref, const Site &site, ValueRefs &refs,
                         llvm::json::Object &err) {
  ref = ref.trim();
  if (ref.starts_with("!")) {
    unsigned index = 0;
    if (!site.hasArgs) {
      err = errResponse("invalid",
                        "'" + ref.str() + "' names an argument of a call, and there is none here");
      return nullptr;
    }
    if (ref.drop_front().getAsInteger(10, index) || index >= site.args.size()) {
      err = errResponse("not_found", "'" + ref.str() + "' is not an argument here");
      return nullptr;
    }
    return site.args[index];
  }
  if (ref.starts_with("#")) {
    err = errResponse(
        "invalid",
        "an assumption names a value as %x or !N; #N only chooses the instruction it goes before");
    return nullptr;
  }
  if (!site.names) {
    err = errResponse("invalid", "'%" + ref.drop_front().str() +
                                     "' names a value, but here only arguments may be named, as "
                                     "!0, !1, ...");
    return nullptr;
  }
  llvm::Value *value = refs.resolve(ref);
  if (!value)
    err = errResponse("not_found", "'" + ref.str() + "' is not a value");
  return value;
}

// A fact about one value, as the attributes `edit attrs` puts on a parameter.
bool applyFact(const llvm::json::Object &item, const Site &site, ValueRefs &refs,
               llvm::IRBuilder<> &builder, llvm::Value *&condition,
               std::vector<llvm::OperandBundleDef> &bundles, llvm::json::Object &err) {
  llvm::LLVMContext &ctx = builder.getContext();
  auto *facts = item.getObject("fact");
  if (facts->empty()) {
    err = errResponse("bad_request", "fact object cannot be empty");
    return false;
  }
  auto of = item.getString("of");
  if (!of) {
    err = errResponse("bad_request", "a fact needs 'of', the value it is about");
    return false;
  }
  llvm::Value *value = resolveName(*of, site, refs, err);
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

// A comparison `{op, lhs, rhs}` as one icmp. An operand is a name or an
// integer, and an integer takes the type of the other operand.
bool applyComparison(const llvm::json::Object &item, const Site &site, ValueRefs &refs,
                     llvm::IRBuilder<> &builder, llvm::Value *&condition, llvm::json::Object &err) {
  using P = llvm::CmpInst::Predicate;
  static const std::pair<llvm::StringRef, P> kOps[] = {
      {"eq", P::ICMP_EQ},   {"ne", P::ICMP_NE},   {"ult", P::ICMP_ULT}, {"ule", P::ICMP_ULE},
      {"ugt", P::ICMP_UGT}, {"uge", P::ICMP_UGE}, {"slt", P::ICMP_SLT}, {"sle", P::ICMP_SLE},
      {"sgt", P::ICMP_SGT}, {"sge", P::ICMP_SGE}};
  auto op = item.getString("op");
  const auto *found = llvm::find_if(kOps, [&](const auto &entry) { return entry.first == *op; });
  if (found == std::end(kOps)) {
    err = errResponse("invalid", "unknown comparison '" + op->str() + "'");
    return false;
  }
  const llvm::json::Value *lhsSpec = item.get("lhs"), *rhsSpec = item.get("rhs");
  if (!lhsSpec || !rhsSpec) {
    err = errResponse("bad_request", "a comparison needs 'lhs' and 'rhs'");
    return false;
  }
  auto operand = [&](const llvm::json::Value &spec, llvm::Type *type) -> llvm::Value * {
    if (auto name = spec.getAsString())
      return resolveName(*name, site, refs, err);
    auto number = spec.getAsInteger();
    if (!number) {
      err = errResponse("bad_request", "an operand is a name or an integer");
      return nullptr;
    }
    if (!type || !type->isIntegerTy()) {
      err = errResponse("invalid", "a number needs an integer value to compare with");
      return nullptr;
    }
    return llvm::ConstantInt::get(type, llvm::APInt(type->getIntegerBitWidth(), *number, true));
  };
  // The named operand first, so that a number can take its type.
  bool numberFirst = lhsSpec->getAsInteger().has_value();
  llvm::Value *first = operand(numberFirst ? *rhsSpec : *lhsSpec, nullptr);
  if (!first)
    return false;
  llvm::Value *second = operand(numberFirst ? *lhsSpec : *rhsSpec, first->getType());
  if (!second)
    return false;
  llvm::Value *lhs = numberFirst ? second : first, *rhs = numberFirst ? first : second;
  if (lhs->getType() != rhs->getType()) {
    err = errResponse("type_mismatch", "a comparison needs two operands of one type");
    return false;
  }
  if (!lhs->getType()->isIntegerTy() && !lhs->getType()->isPointerTy()) {
    err = errResponse("invalid", "a comparison compares integers or pointers");
    return false;
  }
  llvm::Value *cmp = builder.CreateICmp(found->second, lhs, rhs);
  condition = condition ? builder.CreateAnd(condition, cmp) : cmp;
  return true;
}

// Delete a predicate's lines that were parsed but will not go in: they still
// use the function's values, which must not be freed while in use.
void drop(Snippet &predicate) {
  for (llvm::Instruction *I : predicate.insts)
    I->dropAllReferences();
  for (llvm::Instruction *I : predicate.insts)
    I->deleteValue();
  predicate.insts.clear();
}

// A predicate's lines, parsed for the site. They define their own values,
// may not call or touch memory, and end in the i1 that is assumed.
bool parsePredicate(const llvm::json::Array &insts, const Site &site, llvm::Function &F,
                    ValueRefs &refs, Snippet &out, llvm::json::Object &err) {
  std::string lines;
  if (!joinInsts(insts, lines, err))
    return false;
  SnippetScope scope{site.names, false, site.hasArgs ? &site.args : nullptr};
  if (!parseSnippet(F, refs, lines, nullptr, scope, out, err))
    return false;
  for (llvm::Instruction *I : out.insts) {
    if (llvm::isa<llvm::CallInst>(I))
      err = errResponse("invalid", "a predicate cannot call a function");
    else if (llvm::isa<llvm::AllocaInst>(I) || I->mayReadOrWriteMemory())
      err = errResponse("invalid", "a predicate cannot use memory");
  }
  if (err.empty() && !out.insts.back()->getType()->isIntegerTy(1))
    err = errResponse("type_mismatch", "the last line of a predicate must define an i1");
  if (err.empty())
    return true;
  drop(out);
  return false;
}

// The assertions, as assumes just before the site.
bool assumeAt(const Site &site, llvm::ArrayRef<const llvm::json::Object *> items, llvm::Function &F,
              ValueRefs &refs, llvm::json::Object &err) {
  llvm::IRBuilder<> builder(site.before);
  llvm::Value *condition = nullptr;
  std::vector<llvm::OperandBundleDef> bundles;
  for (const auto *item : items) {
    if (item->getObject("fact")) {
      if (!applyFact(*item, site, refs, builder, condition, bundles, err))
        return false;
    } else if (item->getString("op")) {
      if (!applyComparison(*item, site, refs, builder, condition, err))
        return false;
    } else {
      Snippet predicate;
      if (!parsePredicate(*item->getArray("insts"), site, F, refs, predicate, err))
        return false;
      for (llvm::Instruction *I : predicate.insts)
        I->insertBefore(site.before->getIterator());
      llvm::Value *holds = predicate.insts.back();
      condition = condition ? builder.CreateAnd(condition, holds) : holds;
    }
  }
  if (condition)
    builder.CreateAssumption(condition);
  if (!bundles.empty())
    builder.CreateAssumption(builder.getTrue(), bundles);
  return true;
}

// The site just before a call, where `!N` is the call's argument N.
Site beforeCall(llvm::CallInst *call) {
  Site site;
  site.before = call;
  site.args.assign(call->arg_begin(), call->arg_end());
  site.hasArgs = true;
  return site;
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
                       "anchor needs 'at' ('start', 'before_calls', or 'before_inst')");

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
  std::vector<Site> sites;

  if (*at == "start") {
    // `!N` is the function's own argument N, and nothing else is in scope.
    auto fnName = anchorObj->getString("fn");
    if (!fnName)
      return errResponse("bad_request", "anchor with at 'start' needs 'fn'");
    if (F->getName() != *fnName)
      return errResponse("not_found", "no function defined with name '@" + fnName->str() + "'");
    Site site;
    site.before = &*F->getEntryBlock().getFirstInsertionPt();
    for (auto &arg : F->args())
      site.args.push_back(&arg);
    site.hasArgs = true;
    site.names = false;
    sites.push_back(std::move(site));
  } else if (*at == "before_calls") {
    auto fnName = anchorObj->getString("fn");
    if (!fnName)
      return errResponse("bad_request", "anchor with at 'before_calls' needs 'fn'");
    for (auto &I : llvm::instructions(*F)) {
      auto *call = llvm::dyn_cast<llvm::CallInst>(&I);
      if (call && call->getCalledFunction() && call->getCalledFunction()->getName() == *fnName)
        sites.push_back(beforeCall(call));
    }
    if (sites.empty())
      return errResponse("not_found", "no call to '@" + fnName->str() + "'");
  } else if (*at == "before_inst") {
    auto instRef = anchorObj->getString("inst");
    if (!instRef)
      return errResponse("bad_request", "anchor with at 'before_inst' needs 'inst'");
    llvm::Instruction *inst = refs.resolveInst(*instRef);
    if (!inst)
      return errResponse("not_found", "'" + instRef->str() + "' is not an instruction");
    if (auto *call = llvm::dyn_cast<llvm::CallInst>(inst)) {
      sites.push_back(beforeCall(call));
    } else {
      Site site;
      site.before = inst;
      sites.push_back(std::move(site));
    }
  } else {
    return errResponse("bad_request", "unknown anchor at '" + at->str() + "'");
  }

  auto *arr = args.getArray("assertions");
  if (!arr || arr->empty())
    return errResponse("bad_request", "assume needs non-empty 'assertions' array");

  std::vector<const llvm::json::Object *> items;
  for (const auto &val : *arr) {
    const auto *obj = val.getAsObject();
    int kinds = obj ? (obj->getObject("fact") != nullptr) + (obj->getArray("insts") != nullptr) +
                          (obj->getString("op").has_value())
                    : 0;
    if (kinds != 1)
      return errResponse("bad_request", "an assertion is a 'fact', a predicate's 'insts', or "
                                        "a comparison's 'op'");
    items.push_back(obj);
  }

  llvm::json::Object err;
  for (const Site &site : sites)
    if (!assumeAt(site, items, *F, refs, err))
      return err;
  return checkedResponse(M);
}

} // namespace llops
