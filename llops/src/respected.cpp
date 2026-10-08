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

// Whether `F` has an attribute this check reads.
bool checksAny(const llvm::Function &F) {
  bool memory = F.getMemoryEffects() != llvm::MemoryEffects::unknown();
  if (memory || F.hasFnAttribute(Attr::NoFree))
    return true;
  for (unsigned k = 0; k < F.arg_size(); ++k) {
    auto has = [&](Attr::AttrKind kind) { return F.hasParamAttribute(k, kind); };
    if (capturesNone(F, k) || llvm::any_of(kParamKinds, has))
      return true;
  }
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
  std::set<const llvm::Value *> seen;
  std::vector<const llvm::Value *> work{&arg};
  while (!work.empty()) {
    const llvm::Value *v = work.back();
    work.pop_back();
    if (!seen.insert(v).second)
      continue;
    for (const llvm::Use &use : v->uses()) {
      const llvm::User *user = use.getUser();
      unsigned at = use.getOperandNo();
      bool load = llvm::isa<llvm::LoadInst>(user), store = llvm::isa<llvm::StoreInst>(user);
      if ((load && at == llvm::LoadInst::getPointerOperandIndex()) ||
          (store && at == llvm::StoreInst::getPointerOperandIndex()))
        continue;
      if (llvm::isa<llvm::PHINode>(user) || (llvm::isa<llvm::SelectInst>(user) && at > 0) ||
          (llvm::isa<llvm::GEPOperator>(user) && at == 0))
        work.push_back(user);
      else
        return "a pointer from " + textOf(arg) +
               " is used as more than an address: " + textOf(*user);
    }
  }
  return std::nullopt;
}

// Why `F`'s own instructions may break an attribute this check reads, or nothing.
Why broken(const llvm::Function &F) {
  if (!checksAny(F))
    return std::nullopt;
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
      // The intrinsic's own table, not the declaration, says what it touches.
      const llvm::Function *callee = call->getCalledFunction();
      auto id = callee ? callee->getIntrinsicID() : llvm::Intrinsic::not_intrinsic;
      if (id == llvm::Intrinsic::not_intrinsic ||
          !llvm::Intrinsic::getFnAttributes(F.getContext(), id)
               .getMemoryEffects()
               .doesNotAccessMemory())
        return "a call that may touch memory: " + textOf(I);
    } else if (I.mayReadOrWriteMemory()) {
      return "an access other than a plain load or store: " + textOf(I);
    }
    if (address)
      for (const llvm::Value *root : rootsOf(address))
        if (!allows(F, root, write))
          return "an access the attributes forbid: " + textOf(I);
  }
  for (const llvm::Argument &arg : F.args())
    if (arg.getType()->isPtrOrPtrVectorTy())
      if (Why why = escapes(arg))
        return why;
  return std::nullopt;
}

} // namespace

void dropCheckedAttrs(llvm::Function &F) {
  F.removeFnAttr(Attr::Memory);
  F.removeFnAttr(Attr::NoFree);
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

  // `after` is read with its attributes, and then compared to `before` without them.
  Why why = broken(*after);
  dropCheckedAttrs(*after);
  dropIgnoredAttrs(*beforeMwc->mod);
  dropIgnoredAttrs(*afterMwc->mod);
  if (printModule(*beforeMwc->mod) != printModule(*afterMwc->mod))
    why = "after is not before with only attributes this check reads added";

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["respected"] = !why;
  if (why)
    resp["why"] = *why;
  return resp;
}

} // namespace llops
