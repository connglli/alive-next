#include "outline.h"

#include "irutil.h"

#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/AsmParser/Parser.h"
#include "llvm/IR/Instructions.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/Cloning.h"
#include <string>
#include <vector>

namespace llops {

namespace {

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

// The values the suffix uses from the prefix or from the arguments, in
// definition order: prefix instructions first, then arguments. The order is
// what makes the signature reproducible from the program alone.
std::vector<llvm::Value *> liveIn(llvm::Function &F, llvm::BasicBlock &BB, llvm::Instruction *cut) {
  llvm::SmallPtrSet<llvm::Value *, 32> usedBySuffix;
  bool inSuffix = false;
  for (auto &I : BB) {
    inSuffix |= &I == cut;
    if (!inSuffix)
      continue;
    for (const llvm::Use &U : I.operands())
      usedBySuffix.insert(U.get());
  }
  std::vector<llvm::Value *> live;
  for (auto &I : BB) {
    if (&I == cut)
      break;
    if (usedBySuffix.contains(&I))
      live.push_back(&I);
  }
  for (auto &arg : F.args())
    if (usedBySuffix.contains(&arg))
      live.push_back(&arg);
  return live;
}

// Move the suffix into a fresh function and wire a call to it into F.
llvm::Function *makeCallee(llvm::Module &M, llvm::Function &F, llvm::BasicBlock &BB,
                           llvm::Instruction *cut, llvm::StringRef calleeName,
                           llvm::ArrayRef<llvm::Value *> params) {
  std::vector<llvm::Type *> paramTys;
  for (auto *v : params)
    paramTys.push_back(v->getType());
  auto *FTy = llvm::FunctionType::get(F.getReturnType(), paramTys, /*isVarArg=*/false);
  auto *callee = llvm::Function::Create(FTy, llvm::Function::ExternalLinkage, calleeName, &M);
  auto *calleeBB = llvm::BasicBlock::Create(M.getContext(), "entry", callee);

  llvm::DenseMap<llvm::Value *, llvm::Value *> toParam;
  for (unsigned i = 0; i < params.size(); ++i)
    toParam[params[i]] = std::next(callee->arg_begin(), i);

  bool inSuffix = false;
  for (auto &I : BB) {
    inSuffix |= &I == cut;
    if (!inSuffix)
      continue;
    for (llvm::Use &U : I.operands()) {
      auto it = toParam.find(U.get());
      if (it != toParam.end())
        U.set(it->second);
    }
  }
  calleeBB->splice(calleeBB->end(), &BB, cut->getIterator(), BB.end());
  // Named after the move, so that a body value of the same name is the one
  // LLVM renames rather than the parameter the response reports.
  for (unsigned i = 0; i < params.size(); ++i)
    std::next(callee->arg_begin(), i)->setName("p" + std::to_string(i));

  // The outer now ends where the suffix was cut away, so it needs the call
  // and a return of its own.
  std::vector<llvm::Value *> callArgs(params.begin(), params.end());
  auto *call = llvm::CallInst::Create(callee, callArgs, "", &BB);
  llvm::ReturnInst::Create(F.getContext(), F.getReturnType()->isVoidTy() ? nullptr : call, &BB);
  return callee;
}

// Print the module with one function reduced to a declaration. The outer and
// the callee are two views of the same module, so the two programs agree on
// everything except which of the two functions has a body.
std::string printWithoutBody(llvm::Module &M, llvm::StringRef declName) {
  llvm::ValueToValueMapTy vmap;
  auto clone = llvm::CloneModule(M, vmap);
  llvm::Function *drop = clone->getFunction(declName);
  drop->deleteBody();
  // A body carries the attributes that describe it; the declaration left
  // behind should not claim them.
  drop->setAttributes(llvm::AttributeList());
  return printModule(*clone);
}

// The tgt side is outlined against the signature the src side produced. This
// reads that signature and resolves each entry to a tgt value.
bool readTgtParams(llvm::json::Object &args, llvm::Function &F, ValueRefs &refs,
                   llvm::Instruction *cut, std::vector<llvm::Value *> &params,
                   llvm::json::Object &err) {
  auto *spec = args.getArray("params");
  auto *valueMap = args.getObject("value_map");
  if (!spec || !valueMap) {
    err = errResponse("bad_request", "a tgt outline needs 'params' and 'value_map'");
    return false;
  }
  llvm::BasicBlock &BB = *singleBlock(F);
  for (const auto &entry : *spec) {
    const auto *obj = entry.getAsObject();
    auto live = obj ? obj->getString("live") : std::nullopt;
    auto type = obj ? obj->getString("type") : std::nullopt;
    if (!live || !type) {
      err = errResponse("bad_request", "each params entry needs 'live' and 'type'");
      return false;
    }
    auto mapped = valueMap->getString(*live);
    if (!mapped) {
      err = errResponse("bad_request",
                        "value_map does not cover the live value '" + live->str() + "'");
      return false;
    }
    llvm::Value *tgtVal = refs.resolve(*mapped);
    if (!tgtVal) {
      err = errResponse("not_found", "value_map: '" + mapped->str() + "' is not a tgt value");
      return false;
    }
    llvm::SMDiagnostic smd;
    llvm::Type *want = llvm::parseType(*type, smd, *F.getParent());
    if (!want) {
      err = errResponse("bad_request", "params: '" + type->str() + "' is not a type");
      return false;
    }
    if (tgtVal->getType() != want) {
      std::string got;
      llvm::raw_string_ostream os(got);
      tgtVal->getType()->print(os);
      err = errResponse("type_mismatch", "value_map: '" + mapped->str() + "' has type " + got +
                                             " but the signature expects " + type->str());
      return false;
    }
    // A value defined at or after the cut cannot be passed into the callee.
    bool inScope = llvm::isa<llvm::Argument>(tgtVal);
    for (auto &I : BB) {
      if (&I == cut)
        break;
      inScope |= &I == tgtVal;
    }
    if (!inScope) {
      err = errResponse("invalid", "value_map: '" + mapped->str() + "' is not in scope at the cut");
      return false;
    }
    params.push_back(tgtVal);
  }

  // Anything the tgt suffix reads and the map does not carry has no way in.
  for (llvm::Value *v : liveIn(F, BB, cut))
    if (!llvm::is_contained(params, v)) {
      err = errResponse("invalid", "the tgt suffix uses '" + refs.print(*v) +
                                       "', which the value map does not cover");
      return false;
    }
  return true;
}

} // namespace

llvm::json::Object outlineCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  auto cut = args.getString("cut");
  auto calleeName = args.getString("callee");
  auto side = args.getString("side");
  if (!text || !cut || !calleeName || !side || (*side != "src" && *side != "tgt"))
    return errResponse("bad_request", "outline needs 'module', 'side' (src|tgt), 'cut' and "
                                      "'callee'");

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);
  llvm::Module &M = *mwc->mod;

  auto diags = validateModule(M);
  if (!diags.empty())
    return errResponse(diags.front().code, diags.front().message);
  if (M.getNamedValue(*calleeName))
    return errResponse("invalid", "the name '@" + calleeName->str() + "' is already taken");

  llvm::Function *F = singleFunction(M);
  llvm::BasicBlock *BB = singleBlock(*F);
  ValueRefs refs(*F);
  llvm::Instruction *cutInst = refs.resolveInst(*cut);
  if (!cutInst)
    return errResponse("not_found", "the cut point '" + cut->str() + "' does not exist");

  std::vector<llvm::Value *> params;
  llvm::json::Array paramInfo;
  if (*side == "src") {
    params = liveIn(*F, *BB, cutInst);
    for (auto *v : params) {
      llvm::json::Object p;
      std::string ty;
      llvm::raw_string_ostream os(ty);
      v->getType()->print(os);
      p["type"] = std::move(ty);
      p["live"] = refs.print(*v);
      paramInfo.emplace_back(std::move(p));
    }
  } else {
    llvm::json::Object err;
    if (!readTgtParams(args, *F, refs, cutInst, params, err))
      return err;
    // Both sides answer with the same signature, so the caller can compare
    // them; the mapping itself is the caller's own input.
    paramInfo = *args.getArray("params");
  }

  llvm::Function *callee = makeCallee(M, *F, *BB, cutInst, *calleeName, params);
  for (unsigned i = 0; i < paramInfo.size(); ++i)
    (*paramInfo[i].getAsObject())["param"] =
        "%" + std::next(callee->arg_begin(), i)->getName().str();

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["outer"] = printWithoutBody(M, callee->getName());
  resp["callee"] = printWithoutBody(M, F->getName());
  resp["params"] = std::move(paramInfo);
  return resp;
}

// ---------------------------------------------------------------------------
// inline
// ---------------------------------------------------------------------------

llvm::json::Object inlineCmd(llvm::json::Object &args) {
  auto outerText = args.getString("outer");
  auto calleeText = args.getString("callee");
  auto calleeName = args.getString("callee_name");
  if (!outerText || !calleeText || !calleeName)
    return errResponse("bad_request", "inline needs 'outer', 'callee' and 'callee_name'");

  std::string parseErr;
  auto outerMwc = parseModule(*outerText, &parseErr);
  if (!outerMwc)
    return errResponse("parse_error", "outer: " + parseErr);
  // Parse the callee into the outer's context so that the two modules share
  // types and constants and only their own definitions need remapping.
  auto calleeMwc = parseModule(*calleeText, &parseErr, *outerMwc->ctx);
  if (!calleeMwc)
    return errResponse("parse_error", "callee: " + parseErr);

  llvm::Module &outerM = *outerMwc->mod;
  llvm::Function *callee = calleeMwc->mod->getFunction(*calleeName);
  if (!callee || callee->isDeclaration())
    return errResponse("not_found", "'@" + calleeName->str() +
                                        "' is not defined in the callee "
                                        "module");
  llvm::BasicBlock *calleeBB = singleBlock(*callee);
  if (!calleeBB)
    return errResponse("shape_error", "the callee must be straightline");

  llvm::Function *F = singleFunction(outerM);
  if (!F)
    return errResponse("shape_error", "the outer module must define exactly one function");
  llvm::BasicBlock *BB = singleBlock(*F);
  if (!BB)
    return errResponse("shape_error", "the outer function must be straightline");

  llvm::Function *decl = outerM.getFunction(*calleeName);
  if (!decl)
    return errResponse("not_found", "the outer does not call '@" + calleeName->str() + "'");
  llvm::CallInst *call = nullptr;
  for (auto &I : *BB)
    if (auto *c = llvm::dyn_cast<llvm::CallInst>(&I))
      if (c->getCalledFunction() == decl) {
        if (call)
          return errResponse("invalid",
                             "the outer calls '@" + calleeName->str() + "' more than once");
        call = c;
      }
  if (!call)
    return errResponse("not_found", "the outer does not call '@" + calleeName->str() + "'");
  if (call->arg_size() != callee->arg_size())
    return errResponse("type_mismatch", "the call and the callee disagree on the argument count");

  // The map covers both halves of the move: the callee's parameters become
  // the call's arguments, and every symbol the callee body names is redirected
  // to the outer module's own. A function the outer does not know is declared
  // there, which is what the callee's own declarations were.
  llvm::ValueToValueMapTy vmap;
  for (unsigned i = 0; i < callee->arg_size(); ++i)
    vmap[std::next(callee->arg_begin(), i)] = call->getArgOperand(i);
  for (llvm::GlobalValue &gv : calleeMwc->mod->global_values()) {
    if (&gv == callee)
      continue;
    if (auto *fn = llvm::dyn_cast<llvm::Function>(&gv)) {
      auto *outerFn = outerM.getFunction(fn->getName());
      if (!outerFn) {
        outerFn =
            llvm::Function::Create(fn->getFunctionType(), fn->getLinkage(), fn->getName(), &outerM);
        outerFn->setAttributes(fn->getAttributes());
      }
      vmap[&gv] = outerFn;
      continue;
    }
    if (auto *outerGV = outerM.getNamedValue(gv.getName())) {
      vmap[&gv] = outerGV;
      continue;
    }
    if (!gv.use_empty())
      return errResponse("not_found", "the callee refers to '@" + gv.getName().str() +
                                          "', which the outer module does not have");
  }

  // Instructions move one by one instead of through LLVM's inliner, which
  // would hoist allocas to the entry block. The certificate checker compares
  // the result against the original program, so the order has to survive.
  std::vector<llvm::Instruction *> clones;
  for (auto &I : *calleeBB) {
    if (llvm::isa<llvm::ReturnInst>(&I))
      continue;
    auto *clone = I.clone();
    clone->setName(I.getName());
    vmap[&I] = clone;
    clones.push_back(clone);
  }
  for (auto *clone : clones) {
    clone->insertInto(BB, call->getIterator());
    llvm::RemapInstruction(clone, vmap,
                           llvm::RF_IgnoreMissingLocals | llvm::RF_ReuseAndMutateDistinctMDs);
  }

  llvm::Value *retVal = llvm::cast<llvm::ReturnInst>(calleeBB->getTerminator())->getReturnValue();
  if (retVal) {
    auto it = vmap.find(retVal);
    if (it != vmap.end())
      retVal = it->second;
  }
  if (!call->getType()->isVoidTy())
    call->replaceAllUsesWith(retVal);
  call->eraseFromParent();
  // The declaration exists only to carry the call, so drop it once the call
  // is gone. Otherwise the result could not match the program it came from.
  if (decl->use_empty())
    decl->eraseFromParent();

  auto diags = checkFunction(*F);
  if (diags.empty())
    diags = checkModule(outerM);
  if (!diags.empty())
    return errResponse(diags.front().code, diags.front().message);
  return moduleResponse(outerM);
}

} // namespace llops
