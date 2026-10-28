#include "respected.h"

#include "attrs.h"
#include "irutil.h"
#include "llvm/ADT/STLExtras.h"
#include "llvm/Analysis/TargetLibraryInfo.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/IntrinsicInst.h"
#include "llvm/IR/Intrinsics.h"
#include "llvm/IR/Operator.h"
#include "llvm/Support/ModRef.h"
#include "llvm/Support/raw_ostream.h"
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace llops {

namespace {

using Attr = llvm::Attribute;
// Why not, or nothing when nothing is wrong.
using Why = std::optional<std::string>;

const Attr::AttrKind kParamKinds[] = {Attr::ReadOnly, Attr::WriteOnly, Attr::ReadNone};

std::string textOf(const llvm::Value &v) {
  std::string out;
  llvm::raw_string_ostream os(out);
  v.print(os);
  return llvm::StringRef(out).trim().str();
}

bool capturesNone(llvm::AttributeSet attrs) {
  Attr captures = attrs.getAttribute(Attr::Captures);
  return captures.isValid() && llvm::capturesNothing(captures.getCaptureInfo());
}

bool capturesNone(const llvm::Function &F, unsigned k) {
  return capturesNone(F.getAttributes().getParamAttrs(k));
}

// Whether parameter `k` of `F` has an attribute this check reads.
bool attributed(const llvm::Function &F, unsigned k) {
  auto has = [&](Attr::AttrKind kind) { return F.hasParamAttribute(k, kind); };
  return capturesNone(F, k) || llvm::any_of(kParamKinds, has);
}

// Whether `F` has a memory attribute that leaves some memory out.
bool limitsMemory(const llvm::Function &F) {
  return F.getMemoryEffects() != llvm::MemoryEffects::unknown();
}

// Whether `F` has an attribute this check reads.
bool checksAny(const llvm::Function &F) {
  const Attr::AttrKind kinds[] = {Attr::NoFree, Attr::NoReturn, Attr::WillReturn};
  auto has = [&](Attr::AttrKind kind) { return F.hasFnAttribute(kind); };
  if (limitsMemory(F) || llvm::any_of(kinds, has))
    return true;
  for (unsigned k = 0; k < F.arg_size(); ++k)
    if (attributed(F, k))
      return true;
  return false;
}

// Constants, freeze and parameter contracts need no inference about computed values.
bool nonPoison(const llvm::Value &v) {
  if (llvm::isa<llvm::ConstantInt, llvm::ConstantFP, llvm::ConstantPointerNull,
                llvm::ConstantAggregateZero, llvm::ConstantDataSequential, llvm::GlobalVariable,
                llvm::Function, llvm::FreezeInst>(v))
    return true;
  if (auto *arg = llvm::dyn_cast<llvm::Argument>(&v))
    return arg->hasAttribute(Attr::NoUndef);
  if (llvm::isa<llvm::ConstantStruct, llvm::ConstantArray, llvm::ConstantVector>(v))
    return llvm::all_of(llvm::cast<llvm::Constant>(v).operands(),
                        [](const llvm::Use &U) { return nonPoison(*U.get()); });
  return false;
}

// noundef is redundant only if no return, including its other attributes, can add poison.
void dropRedundantNoundef(llvm::Function &F) {
  if (!F.hasRetAttribute(Attr::NoUndef))
    return;
  for (const llvm::Instruction &I : llvm::instructions(F))
    if (auto *ret = llvm::dyn_cast<llvm::ReturnInst>(&I)) {
      if (!ret->getReturnValue() || !nonPoison(*ret->getReturnValue()))
        return;
      for (const Attr &A : F.getAttributes().getRetAttrs())
        if (retAttrMeaning(A) != AttrMeaning::Ignored && A.getKindAsEnum() != Attr::NoUndef)
          return;
    }
  F.removeRetAttr(Attr::NoUndef);
}

// The values a pointer can come from: back through GEPs, phis and selects to
// an argument, an alloca, a global or any other value, which stands for itself.
std::set<const llvm::Value *> rootsOf(const llvm::Value *pointer) {
  std::set<const llvm::Value *> seen, roots;
  std::vector<const llvm::Value *> work{pointer};
  while (!work.empty()) {
    const llvm::Value *v = work.back();
    work.pop_back();
    if (!seen.insert(v).second)
      continue;
    if (auto *gep = llvm::dyn_cast<llvm::GEPOperator>(v))
      work.push_back(gep->getPointerOperand());
    else if (auto *phi = llvm::dyn_cast<llvm::PHINode>(v))
      for (const llvm::Value *in : phi->incoming_values())
        work.push_back(in);
    else if (auto *select = llvm::dyn_cast<llvm::SelectInst>(v))
      work.insert(work.end(), {select->getTrueValue(), select->getFalseValue()});
    else
      roots.insert(v);
  }
  return roots;
}

// Whether `F`'s attributes let it read, or write, where a pointer from `root` points.
bool allows(const llvm::Function &F, const llvm::Value *root, bool write) {
  if (llvm::isa<llvm::AllocaInst>(root))
    return true;
  auto *global = llvm::dyn_cast<llvm::GlobalVariable>(root);
  if (global && global->isConstant() && !write)
    return true;
  llvm::MemoryEffects effects = F.getMemoryEffects();
  auto lets = [&](llvm::IRMemLocation where) {
    llvm::ModRefInfo how = effects.getModRef(where);
    return write ? llvm::isModSet(how) : llvm::isRefSet(how);
  };
  // alive2 counts an access as argument memory when its pointer comes from an
  // argument, as LangRef does, so a pointer from a global reaches other memory.
  if (global)
    return lets(llvm::IRMemLocation::Other);
  auto *arg = llvm::dyn_cast<llvm::Argument>(root);
  if (!arg)
    return lets(llvm::IRMemLocation::ArgMem) && lets(llvm::IRMemLocation::Other);
  Attr::AttrKind barred = write ? Attr::ReadOnly : Attr::WriteOnly;
  unsigned k = arg->getArgNo();
  return !F.hasParamAttribute(k, barred) && !F.hasParamAttribute(k, Attr::ReadNone) &&
         lets(llvm::IRMemLocation::ArgMem);
}

// Whether alive2 takes `call` for a realloc, which in a nofree function it makes
// undefined on a pointer other than null or a stack slot, whatever the call's own
// attributes say.
bool reallocates(const llvm::CallBase &call) {
  auto hasRealloc = [](llvm::AttributeSet attrs) {
    Attr kind = attrs.getAttribute(Attr::AllocKind);
    return kind.isValid() &&
           (kind.getAllocKind() & llvm::AllocFnKind::Realloc) != llvm::AllocFnKind::Unknown;
  };
  // alive2 accumulates both sets of flags; a call-site attribute cannot hide the declaration's.
  if (hasRealloc(call.getAttributes().getFnAttrs()))
    return true;
  const llvm::Function *callee = call.getCalledFunction();
  return callee &&
         (hasRealloc(callee->getAttributes().getFnAttrs()) ||
          llvm::is_contained({"realloc", "reallocf", "vec_realloc"},
                             llvm::GlobalValue::dropLLVMManglingEscape(callee->getName())));
}

// Whether `call` touches no memory: an intrinsic whose own table, not its
// declaration, says so, or llvm.assume, which alive2 makes an assumption.
bool touchesNothing(const llvm::CallBase &call) {
  const llvm::Function *callee = call.getCalledFunction();
  auto id = callee ? callee->getIntrinsicID() : llvm::Intrinsic::not_intrinsic;
  if (id == llvm::Intrinsic::assume)
    return true;
  return id != llvm::Intrinsic::not_intrinsic &&
         llvm::Intrinsic::getFnAttributes(call.getContext(), id)
             .getMemoryEffects()
             .doesNotAccessMemory();
}

// Recognized llvm.assume bundles state conditions without additional calls or accesses.
bool assumptionBundles(const llvm::CallBase &call) {
  if (call.getIntrinsicID() != llvm::Intrinsic::assume)
    return false;
  for (unsigned k = 0; k < call.getNumOperandBundles(); ++k) {
    llvm::StringRef tag = call.getOperandBundleAt(k).getTagName();
    if (llvm::Attribute::getAttrKindFromName(tag) == Attr::None && tag != "separate_storage")
      return false;
  }
  return true;
}

// Only the static name registry is read here, without a target-library analysis.
// alive2 may replace these calls with operations that do not read their attributes.
bool libraryName(llvm::StringRef name) {
  for (unsigned k = 1; k < llvm::NumLibFuncs; ++k)
    if (llvm::TargetLibraryInfo::getStandardName(static_cast<llvm::LibFunc>(k)) == name)
      return true;
  return false;
}

struct CallAccesses {
  llvm::MemoryEffects memory = llvm::MemoryEffects::none();
  std::vector<llvm::ModRefInfo> args;
  std::vector<bool> nocapture;
  bool nofree = false;

  explicit CallAccesses(unsigned n) : args(n, llvm::ModRefInfo::NoModRef), nocapture(n, false) {}
};

// An upper bound on a call's accesses in LLVM and alive2, or no bound we can check.
std::optional<CallAccesses> callAccesses(const llvm::CallBase &call) {
  const llvm::Function *callee = call.getCalledFunction();
  if (!callee || call.hasOperandBundles() || reallocates(call) || call.hasFnAttr(Attr::AllocKind) ||
      call.hasFnAttr(Attr::AllocSize))
    return std::nullopt;
  CallAccesses out(call.arg_size());
  auto read = llvm::ModRefInfo::Ref;
  auto write = llvm::ModRefInfo::Mod;
  if (auto *mem = llvm::dyn_cast<llvm::MemIntrinsic>(&call)) {
    if (mem->isVolatile())
      return std::nullopt;
    out.args[0] = write;
    if (llvm::isa<llvm::MemTransferInst>(mem))
      out.args[1] = read;
    else if (!llvm::isa<llvm::MemSetInst>(mem))
      return std::nullopt;
    out.nocapture.assign(call.arg_size(), true);
    out.nofree = true;
  } else if (callee->isIntrinsic()) {
    if (!touchesNothing(call))
      return std::nullopt;
    auto attrs = llvm::Intrinsic::getAttributes(call.getContext(), callee->getIntrinsicID(),
                                                callee->getFunctionType());
    for (unsigned k = 0; k < call.arg_size(); ++k)
      out.nocapture[k] = capturesNone(attrs.getParamAttrs(k));
    out.nofree = true;
  } else {
    llvm::StringRef name = llvm::GlobalValue::dropLLVMManglingEscape(callee->getName());
    bool compared = name == "memcmp" || name == "bcmp";
    bool length = name == "strlen";
    if (libraryName(name) && !compared && !length)
      return std::nullopt;
    out.memory = call.getMemoryEffects();
    for (unsigned k = 0; k < call.arg_size(); ++k) {
      if (!holdsPointer(call.getArgOperand(k)->getType()))
        continue;
      if (!call.getArgOperand(k)->getType()->isPointerTy())
        return std::nullopt;
      auto mode = out.memory.getModRef(llvm::IRMemLocation::ArgMem);
      if (call.paramHasAttr(k, Attr::ReadNone))
        mode = llvm::ModRefInfo::NoModRef;
      if (call.paramHasAttr(k, Attr::ReadOnly))
        mode &= read;
      if (call.paramHasAttr(k, Attr::WriteOnly))
        mode &= write;
      out.args[k] = mode;
      // LLVM can intersect partial capture contracts, which alive2 ignores individually.
      out.nocapture[k] = capturesNone(call.getAttributes().getParamAttrs(k)) ||
                         (k < callee->arg_size() && capturesNone(*callee, k));
    }
    // These library calls become reads in alive2, even with narrower attributes.
    for (unsigned k = 0, n = compared ? 2 : length ? 1 : 0; k < n; ++k) {
      if (k >= call.arg_size() || !call.getArgOperand(k)->getType()->isPointerTy())
        return std::nullopt;
      out.args[k] |= read;
    }
  }
  for (unsigned k = 0; k < call.arg_size(); ++k) {
    if (call.paramHasAttr(k, Attr::InAlloca) || call.paramHasAttr(k, Attr::Preallocated) ||
        call.paramHasAttr(k, Attr::Initializes))
      return std::nullopt;
    if (call.paramHasAttr(k, Attr::ByVal))
      out.args[k] |= read;
    if (call.paramHasAttr(k, Attr::Writable))
      out.args[k] |= llvm::ModRefInfo::ModRef;
    if (holdsPointer(call.getType()) && !call.use_empty())
      out.nocapture[k] = false;
  }
  out.nofree |= out.memory.onlyReadsMemory() &&
                llvm::none_of(out.args, [](auto mode) { return llvm::isModSet(mode); });
  return out;
}

// Whether an address observation stays in scalar computations, control flow or returns.
bool observed(const llvm::Instruction &first) {
  std::set<const llvm::Instruction *> seen;
  std::vector<const llvm::Instruction *> work{&first};
  while (!work.empty()) {
    const llvm::Instruction *I = work.back();
    work.pop_back();
    if (!seen.insert(I).second)
      continue;
    if (I->isTerminator() || I->mayReadOrWriteMemory() || llvm::isa<llvm::CallBase>(I) ||
        holdsPointer(I->getType()))
      return false;
    for (const llvm::User *U : I->users()) {
      auto *user = llvm::cast<llvm::Instruction>(U);
      if (!llvm::isa<llvm::BranchInst, llvm::SwitchInst, llvm::ReturnInst>(user))
        work.push_back(user);
    }
  }
  return true;
}

// A pointer may be observed without reading it, but captures(none) also forbids its address.
Why escapes(const llvm::Argument &arg) {
  auto allowed = [&](const llvm::Use &U) {
    auto *I = llvm::cast<llvm::Instruction>(U.getUser());
    if (auto *call = llvm::dyn_cast<llvm::CallBase>(I); call && call->isArgOperand(&U)) {
      auto access = callAccesses(*call);
      return access && access->nocapture[call->getArgOperandNo(&U)];
    }
    return !capturesNone(*arg.getParent(), arg.getArgNo()) && observed(*I);
  };
  if (const llvm::User *user = escapingUse(arg, allowed))
    return "a pointer from " + textOf(arg) + " escapes the checked uses: " + textOf(*user);
  return std::nullopt;
}

// Why `call` may break an attribute of `F` this check reads, or nothing. alive2
// reads memory(...) at the function's own accesses and nofree at its own frees,
// and LangRef over what its callees do too, so a call passes where both keep it.
Why called(const llvm::Function &F, const llvm::CallBase &call) {
  if (call.hasOperandBundles() && !assumptionBundles(call))
    return "a call with unchecked operand bundles: " + textOf(call);
  bool untouched = touchesNothing(call);
  auto access = callAccesses(call);
  if (limitsMemory(F) && !untouched && !access)
    return "a call that may touch memory: " + textOf(call);
  if (access) {
    auto effects = F.getMemoryEffects();
    for (auto loc : llvm::MemoryEffects::locations())
      if (loc != llvm::IRMemLocation::ArgMem &&
          (access->memory.getModRef(loc) & effects.getModRef(loc)) != access->memory.getModRef(loc))
        return "a call that may touch forbidden memory: " + textOf(call);
    for (unsigned k = 0; k < call.arg_size(); ++k)
      for (const llvm::Value *root : rootsOf(call.getArgOperand(k)))
        for (bool write : {false, true})
          if ((write ? llvm::isModSet(access->args[k]) : llvm::isRefSet(access->args[k])) &&
              !allows(F, root, write))
            return "a call access the attributes forbid: " + textOf(call);
  }
  bool frees = reallocates(call) || (!call.hasFnAttr(Attr::NoFree) && !(access && access->nofree));
  if (F.hasFnAttribute(Attr::NoFree) && !untouched && frees)
    return "a call that may free memory: " + textOf(call);
  // alive2 reads willreturn as attrs.cpp's kFnBody lists it, on the callee and
  // the call site, as hasFnAttr does.
  if (F.hasFnAttribute(Attr::WillReturn) && !call.hasFnAttr(Attr::WillReturn))
    return "a call that may not return: " + textOf(call);
  return std::nullopt;
}

// Why `F`'s own instructions may break an attribute this check reads, or nothing.
Why broken(const llvm::Function &F) {
  if (!checksAny(F))
    return std::nullopt;
  // alive2 reads willreturn only at calls; in LLVM, a loop that never ends breaks it too.
  if (F.hasFnAttribute(Attr::WillReturn) && holdsLoop(F))
    return "a loop, which may not end";
  for (const llvm::Instruction &I : llvm::instructions(F)) {
    const llvm::Value *address = nullptr;
    bool write = false;
    if (auto *load = llvm::dyn_cast<llvm::LoadInst>(&I)) {
      if (!load->isSimple())
        return "a volatile or atomic load: " + textOf(I);
      address = load->getPointerOperand();
    } else if (auto *store = llvm::dyn_cast<llvm::StoreInst>(&I)) {
      if (!store->isSimple())
        return "a volatile or atomic store: " + textOf(I);
      address = store->getPointerOperand();
      write = true;
    } else if (auto *call = llvm::dyn_cast<llvm::CallBase>(&I)) {
      if (Why why = called(F, *call))
        return why;
    } else if (llvm::isa<llvm::ReturnInst>(I) && F.hasFnAttribute(Attr::NoReturn)) {
      return "a return, which noreturn forbids";
    } else if (I.mayReadOrWriteMemory()) {
      return "an access other than a plain load or store: " + textOf(I);
    }
    if (address)
      for (const llvm::Value *root : rootsOf(address))
        if (!allows(F, root, write))
          return "an access the attributes forbid: " + textOf(I);
  }
  // Only memory(...) and the parameter attributes follow a pointer from an argument.
  for (const llvm::Argument &arg : F.args())
    if (arg.getType()->isPtrOrPtrVectorTy() && (limitsMemory(F) || attributed(F, arg.getArgNo())))
      if (Why why = escapes(arg))
        return why;
  return std::nullopt;
}

} // namespace

void dropCheckedAttrs(llvm::Function &F) {
  F.removeFnAttr(Attr::Memory);
  F.removeFnAttr(Attr::NoFree);
  F.removeFnAttr(Attr::NoReturn);
  F.removeFnAttr(Attr::WillReturn);
  for (unsigned k = 0; k < F.arg_size(); ++k) {
    for (Attr::AttrKind kind : kParamKinds)
      F.removeParamAttr(k, kind);
    if (capturesNone(F, k))
      F.removeParamAttr(k, Attr::Captures);
  }
  dropRedundantNoundef(F);
}

llvm::json::Object respectedCmd(llvm::json::Object &args) {
  auto beforeText = args.getString("before");
  auto afterText = args.getString("after");
  if (!beforeText || !afterText)
    return errResponse("bad_request", "respected needs 'before' and 'after'");
  std::string parseErr;
  auto beforeMwc = parseModule(*beforeText, &parseErr);
  if (!beforeMwc)
    return errResponse("parse_error", "before: " + parseErr);
  auto afterMwc = parseModule(*afterText, &parseErr);
  if (!afterMwc)
    return errResponse("parse_error", "after: " + parseErr);
  llvm::Function *before = singleFunction(*beforeMwc->mod);
  llvm::Function *after = singleFunction(*afterMwc->mod);
  if (!before || !after)
    return errResponse("shape_error", "respected needs one defined function per module");
  // A recursive call could assume the very function attributes being proved.
  for (auto *mwc : {beforeMwc.get(), afterMwc.get()})
    if (auto diags = validateModule(*mwc->mod); !diags.empty())
      return errResponse(diags.front().code, diags.front().message);
  if (holdsUndef(*beforeMwc->mod) || holdsUndef(*afterMwc->mod))
    return errResponse("undef", "respected does not compare programs that hold undef");

  // `after` is read with its attributes, and then compared to `before` without them.
  Why why = broken(*after);
  dropCheckedAttrs(*after);
  dropRedundantNoundef(*before);
  dropIgnoredAttrs(*beforeMwc->mod);
  dropIgnoredAttrs(*afterMwc->mod);
  if (printModule(*beforeMwc->mod) != printModule(*afterMwc->mod))
    why = "the two programs differ in more than the attributes this check reads";

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["respected"] = !why;
  if (why)
    resp["why"] = *why;
  return resp;
}

} // namespace llops
