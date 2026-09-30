#include "irutil.h"

#include "llvm/ADT/PostOrderIterator.h"
#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/Analysis/CFG.h"
#include "llvm/AsmParser/Parser.h"
#include "llvm/IR/CFG.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Operator.h"
#include "llvm/IR/Verifier.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/Cloning.h"

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

std::string printModule(llvm::Module &M) {
  M.setModuleIdentifier("");
  M.setSourceFileName("");
  std::string out;
  llvm::raw_string_ostream os(out);
  M.print(os, nullptr);
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

std::vector<Diag> checkFunction(llvm::Function &F) {
  std::vector<Diag> diags;

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

std::string ValueRefs::print(const llvm::Value &V) {
  // An instruction that defines no value has neither a name nor a slot, so
  // its reference is its position. Every reference this returns resolves
  // back to the same value.
  if (const auto *I = llvm::dyn_cast<llvm::Instruction>(&V)) {
    if (!I->hasName() && mst.getLocalSlot(I) < 0) {
      unsigned index = 0;
      for (auto &other : llvm::instructions(fn)) {
        if (&other == I)
          return "#" + std::to_string(index);
        ++index;
      }
    }
  }
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

bool putBackRest(llvm::CallInst &call, llvm::Function &callee, llvm::Function &F,
                 llvm::ValueToValueMapTy &vmap) {
  auto *ret = llvm::dyn_cast_or_null<llvm::ReturnInst>(call.getNextNode());
  if (!ret || ret->getReturnValue() != (call.getType()->isVoidTy() ? nullptr : &call))
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
  if (tgtVal->getType() != want) {
    std::string got;
    llvm::raw_string_ostream os(got);
    tgtVal->getType()->print(os);
    err = errResponse("type_mismatch", "value_map: '" + mapped->str() + "' has type " + got +
                                           " but the signature expects " + type->str());
    return nullptr;
  }
  return tgtVal;
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
