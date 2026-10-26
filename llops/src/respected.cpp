#include "respected.h"

#include "attrs.h"
#include "irutil.h"
#include "llvm/ADT/STLExtras.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
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

bool capturesNone(const llvm::Function &F, unsigned k) {
  Attr captures = F.getParamAttribute(k, Attr::Captures);
  return captures.isValid() && llvm::capturesNothing(captures.getCaptureInfo());
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

// Why a pointer from `arg` may be used as more than an address, or nothing.
// Stored, returned, converted, compared or passed to a call, it could take the
// argument's attributes where this check does not look.
Why escapes(const llvm::Argument &arg) {
  if (const llvm::User *user = escapingUse(arg))
    return "a pointer from " + textOf(arg) + " is used as more than an address: " + textOf(*user);
  return std::nullopt;
}

// Whether alive2 takes `call` for a realloc, which in a nofree function it makes
// undefined on a pointer other than null or a stack slot, whatever the call's own
// attributes say.
bool reallocates(const llvm::CallBase &call) {
  Attr kind = call.getFnAttr(Attr::AllocKind);
  if (kind.isValid() &&
      (kind.getAllocKind() & llvm::AllocFnKind::Realloc) != llvm::AllocFnKind::Unknown)
    return true;
  const llvm::Function *callee = call.getCalledFunction();
  return callee && llvm::is_contained({"realloc", "reallocf", "vec_realloc"}, callee->getName());
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

// Why `call` may break an attribute of `F` this check reads, or nothing. alive2
// reads memory(...) at the function's own accesses and nofree at its own frees,
// and LangRef over what its callees do too, so a call passes where both keep it.
Why called(const llvm::Function &F, const llvm::CallBase &call) {
  bool untouched = touchesNothing(call);
  if (limitsMemory(F) && !untouched)
    return "a call that may touch memory: " + textOf(call);
  bool frees = !call.hasFnAttr(Attr::NoFree) || reallocates(call);
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
  // Only a module the verifier accepts is a program this check can answer for.
  for (auto *mwc : {beforeMwc.get(), afterMwc.get()})
    if (auto diags = checkModule(*mwc->mod); !diags.empty())
      return errResponse(diags.front().code, diags.front().message);

  // `after` is read with its attributes, and then compared to `before` without them.
  Why why = broken(*after);
  dropCheckedAttrs(*after);
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
