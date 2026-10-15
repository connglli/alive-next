#include "irutil.h"

#include "attrs.h"

#include "llvm/ADT/PostOrderIterator.h"
#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/Analysis/CFG.h"
#include "llvm/AsmParser/Parser.h"
#include "llvm/IR/CFG.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Intrinsics.h"
#include "llvm/IR/Operator.h"
#include "llvm/IR/Verifier.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/Support/FormattedStream.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/Cloning.h"
#include <set>

namespace llops {

std::unique_ptr<ModuleWithCtx> parseModule(llvm::StringRef text, std::string *err) {
  // Own the context with a real shared_ptr: the shared overload aliases it
  // with a no-op deleter, which would let the context die here.
  auto ctx = std::make_shared<llvm::LLVMContext>();
  auto mwc = parseModule(text, err, *ctx);
  if (!mwc)
    return nullptr;
  mwc->ctx = std::move(ctx);
  return mwc;
}

std::unique_ptr<ModuleWithCtx> parseModule(llvm::StringRef text, std::string *err,
                                           llvm::LLVMContext &sharedCtx) {
  auto mwc = std::make_unique<ModuleWithCtx>();
  mwc->ctx = std::shared_ptr<llvm::LLVMContext>(&sharedCtx, [](auto) {});
  llvm::SMDiagnostic smd;
  auto buf = llvm::MemoryBuffer::getMemBuffer(text, "<module>");
  mwc->mod = llvm::parseIR(buf->getMemBufferRef(), smd, *mwc->ctx);
  if (!mwc->mod) {
    if (err) {
      llvm::raw_string_ostream os(*err);
      smd.print("llops", os);
    }
    return nullptr;
  }
  return mwc;
}

std::string printModule(llvm::Module &M, llvm::AssemblyAnnotationWriter *annotator) {
  M.setModuleIdentifier("");
  M.setSourceFileName("");
  std::string out;
  llvm::raw_string_ostream os(out);
  M.print(os, annotator);
  // With no header lines left, LLVM's separator before the first definition
  // becomes a leading blank line.
  return llvm::StringRef(out).ltrim('\n').str();
}

llvm::Function *singleFunction(llvm::Module &M) {
  llvm::Function *found = nullptr;
  for (auto &F : M) {
    if (F.isDeclaration())
      continue;
    if (found)
      return nullptr; // more than one defined function
    found = &F;
  }
  return found;
}

llvm::BasicBlock *singleBlock(llvm::Function &F) {
  if (F.empty() || std::next(F.begin()) != F.end())
    return nullptr;
  return &F.getEntryBlock();
}

namespace {

// Blocks in reverse postorder from the entry, following each terminator's
// successors in order, so where a block was printed does not change what the
// program canonicalizes to. Blocks the entry does not reach follow the rest.
void layOutBlocks(llvm::Function &F) {
  llvm::BasicBlock *last = nullptr;
  for (llvm::BasicBlock *BB : llvm::ReversePostOrderTraversal<llvm::Function *>(&F)) {
    if (last)
      BB->moveAfter(last);
    last = BB;
  }
}

llvm::DenseMap<const llvm::BasicBlock *, unsigned> positions(llvm::Function &F) {
  llvm::DenseMap<const llvm::BasicBlock *, unsigned> position;
  unsigned next = 0;
  for (auto &B : F)
    position[&B] = next++;
  return position;
}

// A phi's incoming pairs in the order of the blocks they come from, so the
// order a transformation happened to add them in does not show.
void sortIncoming(llvm::Function &F) {
  auto position = positions(F);
  for (auto &B : F)
    for (auto &phi : B.phis()) {
      std::vector<std::pair<llvm::BasicBlock *, llvm::Value *>> incoming;
      for (unsigned i = 0; i < phi.getNumIncomingValues(); ++i)
        incoming.push_back({phi.getIncomingBlock(i), phi.getIncomingValue(i)});
      std::stable_sort(incoming.begin(), incoming.end(), [&](const auto &a, const auto &b) {
        return position[a.first] < position[b.first];
      });
      for (unsigned i = 0; i < incoming.size(); ++i) {
        phi.setIncomingBlock(i, incoming[i].first);
        phi.setIncomingValue(i, incoming[i].second);
      }
    }
}

// A block's uses in the order of the blocks using it, since the printer lists
// a block's predecessors in use order, which otherwise follows how the module
// was built or parsed.
void sortPredecessors(llvm::Function &F) {
  auto position = positions(F);
  auto key = [&](const llvm::Use &U) {
    auto *I = llvm::dyn_cast<llvm::Instruction>(U.getUser());
    return std::make_pair(I ? position.lookup(I->getParent()) : ~0u, U.getOperandNo());
  };
  for (auto &B : F)
    B.sortUseList([&](const llvm::Use &L, const llvm::Use &R) { return key(L) < key(R); });
}

} // namespace

std::string canonModule(llvm::Module &M) {
  for (auto &F : M) {
    if (F.isDeclaration())
      continue;
    layOutBlocks(F);
    sortIncoming(F);
    sortPredecessors(F);
    for (auto &arg : F.args())
      arg.setName("");
    // Every block loses its name before any gets a new one, since LLVM
    // renames a block that takes a name another block still holds.
    for (auto &BB : F)
      BB.setName("");
    unsigned blockIndex = 0;
    for (auto &BB : F) {
      // Blocks keep a name, because an unnamed block consumes a slot number
      // and would shift the numbering of the values around it.
      BB.setName(blockIndex == 0 ? "entry" : "bb" + std::to_string(blockIndex));
      ++blockIndex;
      for (auto &I : BB)
        I.setName("");
    }
  }
  return printModule(M);
}

// ---------------------------------------------------------------------------
// Well-formedness
// ---------------------------------------------------------------------------

namespace {

// Use before definition, reported on its own because it is the mistake edits
// make most often and the LLVM verifier's version of it names no values.
bool findUseBeforeDef(llvm::Function &F, llvm::BasicBlock &BB, ValueRefs &refs, Diag &out) {
  llvm::SmallPtrSet<const llvm::Value *, 32> defined;
  for (auto &arg : F.args())
    defined.insert(&arg);
  for (auto &I : BB) {
    for (const llvm::Use &U : I.operands()) {
      auto *op = U.get();
      // Only values defined in this function can be out of order; constants
      // and globals are in scope everywhere, and a value belonging to another
      // function is the verifier's business.
      if (!llvm::isa<llvm::Instruction>(op) || defined.contains(op))
        continue;
      if (llvm::cast<llvm::Instruction>(op)->getFunction() != &F)
        continue;
      out = {Diag::Severity::Error, "dominance",
             "'" + refs.print(*op) + "' is used before its definition"};
      return true;
    }
    defined.insert(&I);
  }
  return false;
}

} // namespace

bool holdsLoop(const llvm::Function &F) {
  // Only blocks the entry reaches are searched; the rest never run.
  llvm::SmallVector<std::pair<const llvm::BasicBlock *, const llvm::BasicBlock *>> back;
  llvm::FindFunctionBackedges(F, back);
  return !back.empty();
}

const llvm::User *escapingUse(const llvm::Value &v) {
  std::set<const llvm::Value *> seen;
  std::vector<const llvm::Value *> work{&v};
  while (!work.empty()) {
    const llvm::Value *from = work.back();
    work.pop_back();
    if (!seen.insert(from).second)
      continue;
    for (const llvm::Use &use : from->uses()) {
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
        return user;
    }
  }
  return nullptr;
}

std::vector<Diag> checkFunction(llvm::Function &F) {
  std::vector<Diag> diags;

  for (unsigned k = 0; k < F.arg_size(); ++k)
    for (const llvm::Attribute &A : F.getAttributes().getParamAttrs(k))
      if (paramAttrMeaning(A) == AttrMeaning::Refused) {
        diags.push_back({Diag::Severity::Error, "unsupported_attr",
                         "alive2 does not check '" + A.getAsString() + "' on a parameter"});
        return diags;
      }

  // Calls must go to a declared function: a call to the one defined function
  // is recursion, and an indirect call has no callee to check against.
  for (auto &I : llvm::instructions(F)) {
    auto *call = llvm::dyn_cast<llvm::CallInst>(&I);
    if (!call)
      continue;
    if (call->isInlineAsm()) {
      diags.push_back({Diag::Severity::Error, "inline_asm", "inline assembly is not supported"});
      return diags;
    }
    llvm::Function *callee = call->getCalledFunction();
    if (!callee) {
      diags.push_back({Diag::Severity::Error, "indirect_call", "indirect calls are not supported"});
      return diags;
    }
    if (!callee->isDeclaration()) {
      diags.push_back({Diag::Severity::Error, "recursive_call",
                       "call to the defined function '" + callee->getName().str() + "'"});
      return diags;
    }
  }

  if (auto *BB = singleBlock(F)) {
    ValueRefs refs(F);
    Diag useBeforeDef;
    if (findUseBeforeDef(F, *BB, refs, useBeforeDef)) {
      diags.push_back(useBeforeDef);
      return diags;
    }
  }

  for (auto &B : F) {
    auto *term = B.getTerminator();
    if (!term) {
      diags.push_back(
          {Diag::Severity::Error, "no_terminator", "a block does not end in a terminator"});
      return diags;
    }
    if (!llvm::isa<llvm::ReturnInst, llvm::BranchInst, llvm::SwitchInst, llvm::UnreachableInst>(
            term)) {
      diags.push_back({Diag::Severity::Error, "unsupported_terminator",
                       "a block ends in '" + std::string(term->getOpcodeName()) +
                           "', not in ret, br, switch or unreachable"});
      return diags;
    }
  }
  return diags;
}

std::vector<Diag> checkModule(llvm::Module &M) {
  std::vector<Diag> diags;
  std::string msg;
  llvm::raw_string_ostream os(msg);
  if (llvm::verifyModule(M, &os))
    diags.push_back({Diag::Severity::Error, "invalid_ir", llvm::StringRef(msg).trim().str()});
  return diags;
}

namespace {

// Undef itself carries nothing, but an aggregate or a constant expression
// accepts one anywhere a constant is accepted, so the search follows
// operands. Not every operand of a constant is one: the block of a
// BlockAddress is not.
bool constantHoldsUndef(const llvm::Constant *C) {
  // PoisonValue derives from UndefValue, and poison stays inside the model.
  if (llvm::isa<llvm::PoisonValue>(C))
    return false;
  if (llvm::isa<llvm::UndefValue>(C))
    return true;
  // A global symbol is an address constant, never an undef value. Its
  // initializer, aliasee, or resolver is inspected by the module-level loops
  // in holdsUndef, so recursing into it here would be redundant at best and
  // an infinite loop at worst (a global's operand 0 is its initializer,
  // which may reference the global itself).
  if (llvm::isa<llvm::GlobalValue>(C))
    return false;
  for (const llvm::Use &U : C->operands())
    if (auto *op = llvm::dyn_cast<llvm::Constant>(U.get()))
      if (constantHoldsUndef(op))
        return true;
  return false;
}

} // namespace

bool holdsUndef(const llvm::Module &M) {
  // Everything that can hold a value at run time: initializers, indirect
  // symbols and resolvers, personality functions, and instruction operands,
  // which include call arguments and operand bundles. Metadata is left out:
  // it names no runtime state.
  for (const auto &G : M.globals())
    if (G.hasInitializer() && constantHoldsUndef(G.getInitializer()))
      return true;
  for (const auto &A : M.aliases())
    if (constantHoldsUndef(A.getAliasee()))
      return true;
  for (const auto &I : M.ifuncs())
    if (constantHoldsUndef(I.getResolver()))
      return true;
  for (const auto &F : M) {
    if (F.hasPersonalityFn() && constantHoldsUndef(F.getPersonalityFn()))
      return true;
    for (const auto &I : llvm::instructions(F))
      for (const llvm::Use &U : I.operands())
        if (auto *C = llvm::dyn_cast<llvm::Constant>(U.get()))
          if (constantHoldsUndef(C))
            return true;
  }
  return false;
}

std::vector<Diag> validateModule(llvm::Module &M) {
  std::vector<Diag> diags;

  llvm::Function *F = nullptr;
  for (auto &fn : M) {
    if (fn.isDeclaration())
      continue;
    if (F) {
      diags.push_back(
          {Diag::Severity::Error, "too_many_defines", "a program defines exactly one function"});
      return diags;
    }
    F = &fn;
  }
  if (!F) {
    diags.push_back({Diag::Severity::Error, "no_define", "a program defines exactly one function"});
    return diags;
  }

  diags = checkFunction(*F);
  if (diags.empty())
    diags = checkModule(M);
  return diags;
}

// ---------------------------------------------------------------------------
// Value references
// ---------------------------------------------------------------------------

ValueRefs::ValueRefs(llvm::Function &F) : fn(F), mst(F.getParent()) {
  mst.incorporateFunction(F);
  for (auto &I : llvm::instructions(F))
    body.emplace_back(&I);
}

llvm::Value *ValueRefs::resolve(llvm::StringRef ref) {
  ref = ref.trim();
  if (ref.empty())
    return nullptr;

  if (ref.starts_with("#")) {
    unsigned index = 0;
    if (ref.drop_front(1).getAsInteger(10, index))
      return nullptr;
    return index < body.size() ? static_cast<llvm::Value *>(body[index]) : nullptr;
  }

  if (ref.starts_with("%"))
    ref = ref.drop_front(1);
  // A quoted reference is always a name: LLVM quotes names that are not plain
  // identifiers, and %"0" is a name rather than slot zero.
  bool quoted = ref.starts_with("\"") && ref.ends_with("\"") && ref.size() >= 2;
  if (quoted)
    ref = ref.drop_front(1).drop_back(1);

  unsigned slot = 0;
  if (!quoted && !ref.empty() && llvm::all_of(ref, llvm::isDigit) && !ref.getAsInteger(10, slot)) {
    for (auto &arg : fn.args())
      if (mst.getLocalSlot(&arg) == (int)slot)
        return &arg;
    for (auto &I : llvm::instructions(fn))
      if (!I.getType()->isVoidTy() && mst.getLocalSlot(&I) == (int)slot)
        return &I;
    return nullptr;
  }

  for (auto &arg : fn.args())
    if (arg.getName() == ref)
      return &arg;
  for (auto &I : llvm::instructions(fn))
    if (I.getName() == ref)
      return &I;
  return nullptr;
}

llvm::Instruction *ValueRefs::resolveInst(llvm::StringRef ref) {
  return llvm::dyn_cast_or_null<llvm::Instruction>(resolve(ref));
}

std::optional<unsigned> ValueRefs::indexOf(const llvm::Instruction &I) const {
  for (unsigned index = 0; index < body.size(); ++index)
    if (static_cast<const llvm::Value *>(body[index]) == &I)
      return index;
  return std::nullopt;
}

namespace {

// Writes `; #N` after each instruction of the body.
class Marks : public llvm::AssemblyAnnotationWriter {
public:
  explicit Marks(const ValueRefs &refs) : refs(refs) {}

  void printInfoComment(const llvm::Value &V, llvm::formatted_raw_ostream &os) override {
    const auto *I = llvm::dyn_cast<llvm::Instruction>(&V);
    auto index = I ? refs.indexOf(*I) : std::nullopt;
    if (!index)
      return;
    os.PadToColumn(50);
    os << "; #" << *index;
  }

private:
  const ValueRefs &refs;
};

} // namespace

std::string printNumbered(llvm::Module &M, const ValueRefs &refs) {
  Marks marks(refs);
  return printModule(M, &marks);
}

std::string ValueRefs::print(const llvm::Value &V) {
  // An instruction that defines no value has neither a name nor a slot, so
  // its reference is its position. Every reference this returns resolves
  // back to the same value.
  if (const auto *I = llvm::dyn_cast<llvm::Instruction>(&V))
    if (!I->hasName() && mst.getLocalSlot(I) < 0)
      if (auto index = indexOf(*I))
        return "#" + std::to_string(*index);
  std::string out;
  llvm::raw_string_ostream os(out);
  V.printAsOperand(os, /*PrintType=*/false, mst);
  return out;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

void addDiagnostics(llvm::json::Object &O, llvm::ArrayRef<Diag> diags) {
  llvm::json::Array arr;
  for (const auto &d : diags) {
    llvm::json::Object obj;
    obj["severity"] = d.severity == Diag::Severity::Error ? "error" : "warning";
    obj["code"] = d.code;
    obj["message"] = d.message;
    arr.emplace_back(std::move(obj));
  }
  O["diagnostics"] = std::move(arr);
}

llvm::json::Object errResponse(llvm::StringRef code, llvm::StringRef message) {
  // json::Value(StringRef) stores a pointer, not a copy, and the IR these
  // strings come from dies with the request, so copy into owning strings.
  llvm::json::Object err;
  err["code"] = code.str();
  err["message"] = message.str();
  llvm::json::Object resp;
  resp["ok"] = false;
  resp["error"] = std::move(err);
  return resp;
}

llvm::json::Object moduleResponse(llvm::Module &M) {
  llvm::json::Object resp;
  resp["ok"] = true;
  resp["module"] = printModule(M);
  return resp;
}

std::optional<Diag> departure(llvm::Module &M) {
  auto diags = validateModule(M);
  if (diags.empty())
    return std::nullopt;
  return diags.front();
}

llvm::json::Object checkedResponse(llvm::Module &M) {
  if (auto d = departure(M))
    return errResponse(d->code, d->message);
  return moduleResponse(M);
}

bool plainCall(const llvm::CallInst &call) {
  auto *fp = llvm::dyn_cast<llvm::FPMathOperator>(&call);
  return call.getAttributes().isEmpty() && !call.hasMetadata() && !call.hasOperandBundles() &&
         call.getCallingConv() == llvm::CallingConv::C &&
         call.getTailCallKind() == llvm::CallInst::TCK_None &&
         !(fp && fp->getFastMathFlags().any());
}

namespace {

// What an instruction of a callee depends on that the callee does not share
// with the code around its call, or nothing.
std::optional<std::string> frameHazard(const llvm::Instruction &I, bool window) {
  static const std::string ownFrame = ", and a callee has a frame of its own";
  static const std::string variadic =
      ", which works on variadic arguments, and a callee is passed none";
  if (window && llvm::isa<llvm::AllocaInst>(I))
    return "allocates stack memory, which a window frees when it returns rather than when the "
           "function does";
  if (llvm::isa<llvm::VAArgInst>(I))
    return "holds a va_arg" + variadic;
  auto *call = llvm::dyn_cast<llvm::CallInst>(&I);
  if (!call)
    return std::nullopt;
  if (call->isMustTailCall())
    return "holds a musttail call, which must match the signature of the function it is in, "
           "and a callee has a signature of its own";
  if (call->hasInAllocaArgument() || call->getOperandBundle(llvm::LLVMContext::OB_preallocated))
    return "passes an inalloca or preallocated argument, which belongs to the frame that makes "
           "the call" +
           ownFrame;
  std::string why;
  switch (call->getIntrinsicID()) {
  case llvm::Intrinsic::stacksave:
  case llvm::Intrinsic::stackrestore:
  case llvm::Intrinsic::returnaddress:
  case llvm::Intrinsic::addressofreturnaddress:
  case llvm::Intrinsic::frameaddress:
  case llvm::Intrinsic::sponentry:
  case llvm::Intrinsic::localescape:
  case llvm::Intrinsic::localrecover:
    why = ", which depends on the frame it runs in" + ownFrame;
    break;
  case llvm::Intrinsic::vastart:
  case llvm::Intrinsic::vacopy:
  case llvm::Intrinsic::vaend:
    why = variadic;
    break;
  default:
    return std::nullopt;
  }
  return "calls '@" + call->getCalledFunction()->getName().str() + "'" + why;
}

} // namespace

std::optional<Diag> frameDependence(const llvm::Function &callee, bool window) {
  for (const auto &I : llvm::instructions(callee))
    if (auto what = frameHazard(I, window))
      return Diag{Diag::Severity::Error, "frame_dependent",
                  "'@" + callee.getName().str() + "' " + *what};
  return std::nullopt;
}

bool putBackRest(llvm::CallInst &call, llvm::Function &callee, llvm::Function &F,
                 llvm::ValueToValueMapTy &vmap,
                 const llvm::SmallPtrSetImpl<llvm::Instruction *> *skip) {
  auto *ret = llvm::dyn_cast_or_null<llvm::ReturnInst>(call.getNextNode());
  if (!ret || ret->getReturnValue() != (call.getType()->isVoidTy() ? nullptr : &call) ||
      call.getNumUses() > 1)
    return false;
  llvm::BasicBlock *head = call.getParent();
  ret->eraseFromParent();
  call.eraseFromParent();
  std::vector<llvm::Instruction *> clones;
  for (auto &B : callee) {
    llvm::BasicBlock *into = &B == &callee.getEntryBlock()
                                 ? head
                                 : llvm::BasicBlock::Create(F.getContext(), B.getName(), &F);
    vmap[&B] = into;
    for (auto &I : B) {
      if (skip && skip->contains(&I))
        continue;
      auto *clone = I.clone();
      clone->setName(I.getName());
      clone->insertInto(into, into->end());
      vmap[&I] = clone;
      clones.push_back(clone);
    }
  }
  for (auto *clone : clones)
    llvm::RemapInstruction(clone, vmap,
                           llvm::RF_IgnoreMissingLocals | llvm::RF_ReuseAndMutateDistinctMDs);
  return true;
}

bool privateSlot(const llvm::AllocaInst &slot) {
  llvm::Type *type = slot.getAllocatedType();
  if (!type->isSingleValueType() || !slot.isStaticAlloca() || slot.isArrayAllocation() ||
      slot.isSwiftError())
    return false;
  return llvm::all_of(slot.uses(), [&](const llvm::Use &use) {
    if (auto *load = llvm::dyn_cast<llvm::LoadInst>(use.getUser()))
      return load->isSimple() && load->getType() == type;
    auto *store = llvm::dyn_cast<llvm::StoreInst>(use.getUser());
    return store && store->isSimple() && use.getOperandNo() == store->getPointerOperandIndex() &&
           store->getValueOperand()->getType() == type;
  });
}

llvm::AllocaInst *heldSlot(llvm::Value &v) {
  auto *slot = llvm::dyn_cast<llvm::AllocaInst>(&v);
  return slot && privateSlot(*slot) ? slot : nullptr;
}

llvm::Type *passedType(llvm::Value &v) {
  llvm::AllocaInst *slot = heldSlot(v);
  return slot ? slot->getAllocatedType() : v.getType();
}

std::optional<std::vector<unsigned>> slotParams(const llvm::json::Object &args, unsigned count) {
  std::vector<unsigned> slots;
  const llvm::json::Value *given = args.get("slots");
  if (!given)
    return slots;
  const llvm::json::Array *list = given->getAsArray();
  if (!list)
    return std::nullopt;
  for (const auto &entry : *list) {
    auto i = entry.getAsInteger();
    if (!i || *i < 0 || *i >= count || (!slots.empty() && *i <= slots.back()))
      return std::nullopt;
    slots.push_back(*i);
  }
  return slots;
}

std::optional<std::vector<llvm::LoadInst *>> slotLoads(llvm::CallInst &call,
                                                       llvm::ArrayRef<unsigned> slots) {
  std::vector<llvm::LoadInst *> loads(slots.size(), nullptr);
  llvm::Instruction *at = &call;
  for (unsigned k = slots.size(); k-- > 0;) {
    auto *load = llvm::dyn_cast_or_null<llvm::LoadInst>(at->getPrevNode());
    auto *slot = load ? llvm::dyn_cast<llvm::AllocaInst>(load->getPointerOperand()) : nullptr;
    llvm::Value *arg = slot ? call.getArgOperand(slots[k]) : nullptr;
    bool passed = arg == load && load->hasOneUse();
    bool dead = llvm::isa_and_nonnull<llvm::PoisonValue>(arg) && load->use_empty();
    if (!(passed || dead) || !privateSlot(*slot) || load->getAlign() > slot->getAlign())
      return std::nullopt;
    loads[k] = load;
    at = load;
  }
  return loads;
}

std::optional<std::vector<llvm::StoreInst *>> slotCopies(llvm::Function &callee,
                                                         llvm::ArrayRef<unsigned> slots) {
  llvm::BasicBlock &entry = callee.getEntryBlock();
  auto at = entry.begin();
  std::vector<llvm::AllocaInst *> own;
  for (unsigned k = 0; k < slots.size(); ++k, ++at) {
    auto *slot = at == entry.end() ? nullptr : llvm::dyn_cast<llvm::AllocaInst>(&*at);
    if (!slot || !privateSlot(*slot))
      return std::nullopt;
    own.push_back(slot);
  }
  std::vector<llvm::StoreInst *> stores;
  for (unsigned k = 0; k < slots.size(); ++k, ++at) {
    auto *store = at == entry.end() ? nullptr : llvm::dyn_cast<llvm::StoreInst>(&*at);
    llvm::Argument *param = callee.getArg(slots[k]);
    if (!store || store->getPointerOperand() != own[k] || store->getValueOperand() != param ||
        !param->hasOneUse() || store->getAlign() > own[k]->getAlign())
      return std::nullopt;
    stores.push_back(store);
  }
  return stores;
}

bool storedBeforeRead(llvm::StoreInst &copying) {
  llvm::Value *slot = copying.getPointerOperand();
  // Blocks a path enters before it stores into the slot again, scanned from their start.
  llvm::SmallPtrSet<llvm::BasicBlock *, 16> entered;
  std::vector<llvm::BasicBlock::iterator> todo = {std::next(copying.getIterator())};
  while (!todo.empty()) {
    llvm::BasicBlock::iterator at = todo.back();
    todo.pop_back();
    llvm::BasicBlock *block = at->getParent();
    bool stored = false;
    for (; at != block->end() && !stored; ++at) {
      auto *load = llvm::dyn_cast<llvm::LoadInst>(&*at);
      if (load && load->getPointerOperand() == slot && !load->use_empty())
        return false;
      auto *store = llvm::dyn_cast<llvm::StoreInst>(&*at);
      stored = store && store->getPointerOperand() == slot;
    }
    if (!stored)
      for (llvm::BasicBlock *next : llvm::successors(block))
        if (entered.insert(next).second)
          todo.push_back(next->begin());
  }
  return true;
}

bool deadSlotsUnread(llvm::CallInst &call, llvm::ArrayRef<unsigned> slots,
                     llvm::ArrayRef<llvm::StoreInst *> stores) {
  for (unsigned k = 0; k < slots.size(); ++k)
    if (llvm::isa<llvm::PoisonValue>(call.getArgOperand(slots[k])) && !storedBeforeRead(*stores[k]))
      return false;
  return true;
}

bool slotsBack(llvm::ArrayRef<llvm::LoadInst *> loads, llvm::ArrayRef<llvm::StoreInst *> stores,
               llvm::ValueToValueMapTy &vmap, llvm::SmallPtrSetImpl<llvm::Instruction *> &skip) {
  llvm::SmallPtrSet<llvm::Value *, 8> taken;
  for (unsigned k = 0; k < loads.size(); ++k) {
    auto *slot = llvm::cast<llvm::AllocaInst>(loads[k]->getPointerOperand());
    auto *copy = llvm::cast<llvm::AllocaInst>(stores[k]->getPointerOperand());
    bool same = slot->getAllocatedType() == copy->getAllocatedType() &&
                slot->getAlign() == copy->getAlign() &&
                slot->getAddressSpace() == copy->getAddressSpace();
    if (!same || !taken.insert(slot).second)
      return false;
    vmap[copy] = slot;
    skip.insert(copy);
    skip.insert(stores[k]);
  }
  return true;
}

bool parseCmdShape(llvm::json::Object &args, llvm::StringRef cmd, CmdShape &out,
                   llvm::json::Object &err) {
  auto text = args.getString("module");
  if (!text) {
    err = errResponse("bad_request", cmd.str() + " needs 'module'");
    return false;
  }
  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc) {
    err = errResponse("parse_error", parseErr);
    return false;
  }
  out.mwc = std::move(mwc);
  out.M = out.mwc->mod.get();
  out.F = singleFunction(*out.M);
  if (!out.F) {
    err = errResponse("shape_error",
                      cmd.str() + " needs the program shape: exactly one defined function");
    return false;
  }
  out.refs = std::make_unique<ValueRefs>(*out.F);
  return true;
}

llvm::Value *mappedParam(const llvm::json::Value &entry, const llvm::json::Object &valueMap,
                         llvm::Function &F, ValueRefs &refs, llvm::json::Object &err) {
  const auto *obj = entry.getAsObject();
  auto live = obj ? obj->getString("live") : std::nullopt;
  auto type = obj ? obj->getString("type") : std::nullopt;
  if (!live || !type) {
    err = errResponse("bad_request", "each params entry needs 'live' and 'type'");
    return nullptr;
  }
  auto mapped = valueMap.getString(*live);
  if (!mapped) {
    err =
        errResponse("bad_request", "value_map does not cover the live value '" + live->str() + "'");
    return nullptr;
  }
  llvm::Value *tgtVal = refs.resolve(*mapped);
  if (!tgtVal) {
    err = errResponse("not_found", "value_map: '" + mapped->str() + "' is not a tgt value");
    return nullptr;
  }
  llvm::SMDiagnostic smd;
  llvm::Type *want = llvm::parseType(*type, smd, *F.getParent());
  if (!want) {
    err = errResponse("bad_request", "params: '" + type->str() + "' is not a type");
    return nullptr;
  }
  if (passedType(*tgtVal) != want) {
    std::string got;
    llvm::raw_string_ostream os(got);
    passedType(*tgtVal)->print(os);
    err = errResponse("type_mismatch", "value_map: '" + mapped->str() + "' has type " + got +
                                           " but the signature expects " + type->str());
    return nullptr;
  }
  return tgtVal;
}

llvm::SmallPtrSet<llvm::Instruction *, 16> setOf(llvm::ArrayRef<llvm::Instruction *> window) {
  return llvm::SmallPtrSet<llvm::Instruction *, 16>(window.begin(), window.end());
}

std::vector<llvm::Value *> liveInto(llvm::Function &F,
                                    const llvm::SmallPtrSetImpl<llvm::Instruction *> &inside) {
  llvm::SmallPtrSet<llvm::Value *, 32> used;
  for (auto *I : inside)
    for (const llvm::Use &U : I->operands())
      used.insert(U.get());
  std::vector<llvm::Value *> live;
  for (auto &I : llvm::instructions(F))
    if (!inside.contains(&I) && used.contains(&I))
      live.push_back(&I);
  for (auto &arg : F.args())
    if (used.contains(&arg))
      live.push_back(&arg);
  return live;
}

std::vector<llvm::Instruction *> windowOf(llvm::BasicBlock &BB, llvm::Instruction *from,
                                          llvm::Instruction *to) {
  std::vector<llvm::Instruction *> window;
  bool started = false;
  for (auto &I : BB) {
    started |= &I == from;
    if (!started)
      continue;
    window.push_back(&I);
    if (&I == to)
      return window;
  }
  return {};
}

std::vector<llvm::Instruction *> windowBetween(llvm::Instruction *first, llvm::Instruction *last,
                                               llvm::StringRef from, llvm::StringRef to,
                                               llvm::StringRef hint, llvm::json::Object &err) {
  std::vector<llvm::Instruction *> window = windowOf(*first->getParent(), first, last);
  if (window.empty())
    err = errResponse("invalid", "'" + to.str() + "' does not come at or after '" + from.str() +
                                     "' in its block");
  else if (window.back()->isTerminator())
    err = errResponse("invalid", "a window cannot take the terminator with it" + hint.str());
  else if (llvm::isa<llvm::PHINode>(window.front()))
    err = errResponse("invalid", "a window cannot take a phi, which belongs to its block");
  else
    return window;
  return {};
}

std::vector<llvm::Instruction *>
liveOutOf(llvm::Function &F, llvm::ArrayRef<llvm::Instruction *> window,
          const llvm::SmallPtrSetImpl<llvm::Instruction *> &inside) {
  llvm::DenseMap<const llvm::Instruction *, unsigned> position;
  unsigned next = 0;
  for (auto &I : llvm::instructions(F))
    position[&I] = next++;
  // Where a value is first used: the user's position, then the operand's.
  std::vector<std::pair<std::pair<unsigned, unsigned>, llvm::Instruction *>> live;
  for (auto *I : window) {
    std::optional<std::pair<unsigned, unsigned>> first;
    for (const llvm::Use &U : I->uses()) {
      auto *user = llvm::cast<llvm::Instruction>(U.getUser());
      std::pair<unsigned, unsigned> at{position.lookup(user), U.getOperandNo()};
      if (!inside.contains(user) && (!first || at < *first))
        first = at;
    }
    if (first)
      live.push_back({*first, I});
  }
  llvm::sort(live, [](const auto &a, const auto &b) { return a.first < b.first; });
  std::vector<llvm::Instruction *> out;
  for (auto &entry : live)
    out.push_back(entry.second);
  return out;
}

bool adoptSymbols(llvm::Module &from, llvm::Module &into, const llvm::GlobalValue *skip,
                  llvm::ValueToValueMapTy &vmap, llvm::json::Object &err) {
  for (llvm::GlobalValue &gv : from.global_values()) {
    if (&gv == skip)
      continue;
    if (auto *fn = llvm::dyn_cast<llvm::Function>(&gv)) {
      auto *mine = into.getFunction(fn->getName());
      if (!mine) {
        mine =
            llvm::Function::Create(fn->getFunctionType(), fn->getLinkage(), fn->getName(), &into);
        mine->setAttributes(fn->getAttributes());
      }
      vmap[&gv] = mine;
      continue;
    }
    if (auto *mine = into.getNamedValue(gv.getName())) {
      vmap[&gv] = mine;
      continue;
    }
    if (!gv.use_empty()) {
      err = errResponse("not_found", "the callee refers to '@" + gv.getName().str() +
                                         "', which the outer module does not have");
      return false;
    }
  }
  return true;
}

namespace {

// `M` printed from a copy, with `blank` bodiless and the unused symbols `other` lacks dropped.
std::string sharedText(llvm::Module &M, std::initializer_list<llvm::StringRef> blank,
                       llvm::Module &other) {
  llvm::ValueToValueMapTy vmap;
  auto clone = llvm::CloneModule(M, vmap);
  for (llvm::StringRef name : blank)
    if (auto *fn = clone->getFunction(name)) {
      fn->deleteBody();
      fn->setAttributes(llvm::AttributeList());
    }
  std::vector<llvm::GlobalValue *> alone;
  for (llvm::GlobalValue &gv : clone->global_values())
    if (!other.getNamedValue(gv.getName()) && gv.use_empty())
      alone.push_back(&gv);
  for (llvm::GlobalValue *gv : alone)
    gv->eraseFromParent();
  return printModule(*clone);
}

} // namespace

bool sharedSymbolsAgree(llvm::Module &outerM, llvm::Function &outerFn, llvm::Module &calleeM,
                        llvm::Function &calleeFn, llvm::StringRef hypothesis,
                        llvm::json::Object &err) {
  std::initializer_list<llvm::StringRef> cut = {outerFn.getName(), calleeFn.getName(), hypothesis};
  std::string outerText = sharedText(outerM, cut, calleeM);
  std::string calleeText = sharedText(calleeM, cut, outerM);
  if (outerText == calleeText)
    return true;
  llvm::SmallVector<llvm::StringRef> outerLines, calleeLines;
  llvm::StringRef(outerText).split(outerLines, '\n');
  llvm::StringRef(calleeText).split(calleeLines, '\n');
  auto [o, c] =
      std::mismatch(outerLines.begin(), outerLines.end(), calleeLines.begin(), calleeLines.end());
  llvm::StringRef outerLine = o != outerLines.end() ? *o : "<no such line>";
  llvm::StringRef calleeLine = c != calleeLines.end() ? *c : "<no such line>";
  err = errResponse("invalid", "the outer and the callee disagree about a symbol they "
                               "share\nouter:  " +
                                   outerLine.str() + "\ncallee: " + calleeLine.str());
  return false;
}

} // namespace llops
