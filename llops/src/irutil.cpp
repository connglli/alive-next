#include "irutil.h"

#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Verifier.h"
#include "llvm/IRReader/IRReader.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"

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

std::string canonModule(llvm::Module &M) {
  for (auto &F : M) {
    if (F.isDeclaration())
      continue;
    for (auto &arg : F.args())
      arg.setName("");
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

std::vector<Diag> checkFunction(llvm::Function &F) {
  std::vector<Diag> diags;
  auto *BB = singleBlock(F);
  if (!BB) {
    diags.push_back({Diag::Severity::Error, "not_straightline",
                     "function '" + F.getName().str() + "' must have exactly one basic block"});
    return diags;
  }

  ValueRefs refs(F);
  Diag useBeforeDef;
  if (findUseBeforeDef(F, *BB, refs, useBeforeDef)) {
    diags.push_back(useBeforeDef);
    return diags;
  }

  auto *term = BB->getTerminator();
  if (!term) {
    diags.push_back(
        {Diag::Severity::Error, "no_terminator", "the body does not end in a terminator"});
    return diags;
  }
  if (!llvm::isa<llvm::ReturnInst>(term))
    diags.push_back({Diag::Severity::Error, "unsupported_terminator",
                     "straightline v1 bodies must end in ret; found '" +
                         std::string(term->getOpcodeName()) + "'"});
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

std::vector<Diag> validateModule(llvm::Module &M) {
  std::vector<Diag> diags;

  llvm::Function *F = nullptr;
  for (auto &fn : M) {
    if (fn.isDeclaration())
      continue;
    if (F) {
      diags.push_back(
          {Diag::Severity::Error, "too_many_defines", "v1 modules define exactly one function"});
      return diags;
    }
    F = &fn;
  }
  if (!F) {
    diags.push_back({Diag::Severity::Error, "no_define", "v1 modules define exactly one function"});
    return diags;
  }

  auto *BB = singleBlock(*F);
  if (!BB) {
    diags.push_back({Diag::Severity::Error, "not_straightline",
                     "function '" + F->getName().str() +
                         "' has more than one basic block; v1 is "
                         "straightline only"});
    return diags;
  }

  // Calls must go to a declared function: a call to the one defined function
  // is recursion, and an indirect call has no callee to check against.
  for (auto &I : *BB) {
    auto *call = llvm::dyn_cast<llvm::CallInst>(&I);
    if (!call)
      continue;
    if (call->isInlineAsm()) {
      diags.push_back(
          {Diag::Severity::Error, "inline_asm", "inline assembly is not supported in v1"});
      return diags;
    }
    llvm::Function *callee = call->getCalledFunction();
    if (!callee) {
      diags.push_back(
          {Diag::Severity::Error, "indirect_call", "indirect calls are not supported in v1"});
      return diags;
    }
    if (!callee->isDeclaration()) {
      diags.push_back({Diag::Severity::Error, "recursive_call",
                       "call to the defined function '" + callee->getName().str() + "'"});
      return diags;
    }
  }

  auto bodyDiags = checkFunction(*F);
  diags.insert(diags.end(), bodyDiags.begin(), bodyDiags.end());
  if (diags.empty())
    diags = checkModule(M);
  return diags;
}

// ---------------------------------------------------------------------------
// Value references
// ---------------------------------------------------------------------------

ValueRefs::ValueRefs(llvm::Function &F) : fn(F), mst(F.getParent()) { mst.incorporateFunction(F); }

llvm::Value *ValueRefs::resolve(llvm::StringRef ref) {
  ref = ref.trim();
  if (ref.empty())
    return nullptr;

  auto *BB = singleBlock(fn);
  if (ref.starts_with("#")) {
    unsigned index = 0;
    if (!BB || ref.drop_front(1).getAsInteger(10, index))
      return nullptr;
    for (auto &I : *BB)
      if (index-- == 0)
        return &I;
    return nullptr;
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
    if (BB)
      for (auto &I : *BB)
        if (!I.getType()->isVoidTy() && mst.getLocalSlot(&I) == (int)slot)
          return &I;
    return nullptr;
  }

  for (auto &arg : fn.args())
    if (arg.getName() == ref)
      return &arg;
  if (BB)
    for (auto &I : *BB)
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
      if (auto *BB = singleBlock(fn))
        for (auto &other : *BB) {
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

llvm::json::Object checkedResponse(llvm::Function &F, llvm::Module &M) {
  auto diags = checkFunction(F);
  if (diags.empty())
    diags = checkModule(M);
  if (!diags.empty())
    return errResponse(diags.front().code, diags.front().message);
  return moduleResponse(M);
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
    err =
        errResponse("shape_error", cmd.str() + " needs the v1 shape: exactly one defined function");
    return false;
  }
  out.BB = singleBlock(*out.F);
  if (!out.BB) {
    err = errResponse("shape_error", cmd.str() + " needs a single basic block");
    return false;
  }
  out.refs = std::make_unique<ValueRefs>(*out.F);
  return true;
}

} // namespace llops
