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

// The instructions of a window, as a set: what is inside decides everything
// else, since a value is live in when the window uses it from outside and
// live out when something outside uses it from within.
llvm::SmallPtrSet<llvm::Instruction *, 16> setOf(llvm::ArrayRef<llvm::Instruction *> window) {
  return llvm::SmallPtrSet<llvm::Instruction *, 16>(window.begin(), window.end());
}

// The suffix from `cut`, terminator included: what a cut moves.
std::vector<llvm::Instruction *> suffixFrom(llvm::BasicBlock &BB, llvm::Instruction *cut) {
  std::vector<llvm::Instruction *> window;
  bool started = false;
  for (auto &I : BB) {
    started |= &I == cut;
    if (started)
      window.push_back(&I);
  }
  return window;
}

// The values a window uses from outside it, in definition order: instructions
// before it first, then arguments. The order is what makes the signature
// reproducible from the program alone.
std::vector<llvm::Value *> liveInto(llvm::Function &F, llvm::BasicBlock &BB,
                                    const llvm::SmallPtrSetImpl<llvm::Instruction *> &inside) {
  llvm::SmallPtrSet<llvm::Value *, 32> used;
  for (auto *I : inside)
    for (const llvm::Use &U : I->operands())
      used.insert(U.get());
  std::vector<llvm::Value *> live;
  for (auto &I : BB)
    if (!inside.contains(&I) && used.contains(&I))
      live.push_back(&I);
  for (auto &arg : F.args())
    if (used.contains(&arg))
      live.push_back(&arg);
  return live;
}

// Move a window into a fresh function and leave a call where it was.
//
// A window that ends the function takes the terminator with it, so the callee
// answers with what the function answers with and the outer needs a return of
// its own. A window in the middle leaves the terminator where it is and hands
// back the one value the rest of the body still uses, if there is one.
llvm::Function *moveOut(llvm::Module &M, llvm::Function &F, llvm::BasicBlock &BB,
                        llvm::ArrayRef<llvm::Instruction *> window,
                        const llvm::SmallPtrSetImpl<llvm::Instruction *> &inside,
                        llvm::StringRef calleeName, llvm::ArrayRef<llvm::Value *> params,
                        llvm::Instruction *result) {
  bool takesTheEnd = window.back()->isTerminator();
  std::vector<llvm::Type *> paramTys;
  for (auto *v : params)
    paramTys.push_back(v->getType());
  auto *retTy = takesTheEnd ? F.getReturnType()
                : result    ? result->getType()
                            : llvm::Type::getVoidTy(M.getContext());
  auto *FTy = llvm::FunctionType::get(retTy, paramTys, /*isVarArg=*/false);
  auto *callee = llvm::Function::Create(FTy, llvm::Function::ExternalLinkage, calleeName, &M);
  auto *calleeBB = llvm::BasicBlock::Create(M.getContext(), "entry", callee);

  llvm::DenseMap<llvm::Value *, llvm::Value *> toParam;
  for (unsigned i = 0; i < params.size(); ++i)
    toParam[params[i]] = std::next(callee->arg_begin(), i);
  for (auto *I : window)
    for (llvm::Use &U : I->operands()) {
      auto it = toParam.find(U.get());
      if (it != toParam.end())
        U.set(it->second);
    }

  // The call goes in where the window starts, and only the uses outside the
  // window move to it: the ones inside are what the callee body still is.
  std::vector<llvm::Value *> callArgs(params.begin(), params.end());
  auto *call = llvm::CallInst::Create(callee, callArgs, "", window.front()->getIterator());
  if (result) {
    std::vector<llvm::Use *> outside;
    for (llvm::Use &U : result->uses()) {
      auto *user = llvm::dyn_cast<llvm::Instruction>(U.getUser());
      if (!user || !inside.contains(user))
        outside.push_back(&U);
    }
    for (auto *U : outside)
      U->set(call);
  }

  calleeBB->splice(calleeBB->end(), &BB, window.front()->getIterator(),
                   std::next(window.back()->getIterator()));
  if (takesTheEnd)
    llvm::ReturnInst::Create(F.getContext(), F.getReturnType()->isVoidTy() ? nullptr : call, &BB);
  else
    llvm::ReturnInst::Create(M.getContext(), result, calleeBB);
  // Named after the move, so that a body value of the same name is the one
  // LLVM renames rather than the parameter the response reports.
  for (unsigned i = 0; i < params.size(); ++i)
    std::next(callee->arg_begin(), i)->setName("p" + std::to_string(i));
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
  for (llvm::Value *v : liveInto(F, BB, setOf(suffixFrom(BB, cut))))
    if (!llvm::is_contained(params, v)) {
      err = errResponse("invalid", "the tgt suffix uses '" + refs.print(*v) +
                                       "', which the value map does not cover");
      return false;
    }
  return true;
}

// The instructions from `cut` to `to`, or nothing when `to` does not come at
// or after `from`.
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

// The window values that something outside it uses. A call answers with one
// value, so a window that hands out two cannot become one.
std::vector<llvm::Instruction *>
liveOutOf(llvm::ArrayRef<llvm::Instruction *> window,
          const llvm::SmallPtrSetImpl<llvm::Instruction *> &inside) {
  std::vector<llvm::Instruction *> live;
  for (auto *I : window)
    for (const llvm::Use &U : I->uses()) {
      auto *user = llvm::dyn_cast<llvm::Instruction>(U.getUser());
      if (user && inside.contains(user))
        continue;
      live.push_back(I);
      break;
    }
  return live;
}

} // namespace

llvm::json::Object outlineCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  auto cut = args.getString("cut");
  auto to = args.getString("to");
  auto calleeName = args.getString("callee");
  auto side = args.getString("side");
  if (!text || !cut || !calleeName)
    return errResponse("bad_request", "outline needs 'module', 'cut' and 'callee'");
  // A cut is outlined differently on each side, since the two have to end up
  // with one signature. A window is one program's own business, so it takes
  // none of what says how two of them line up.
  if (!to && (!side || (*side != "src" && *side != "tgt")))
    return errResponse("bad_request", "a cut needs 'side' (src|tgt)");
  if (to && (side || args.get("params") || args.get("value_map")))
    return errResponse("bad_request", "a window is outlined the same way whichever side it is on, "
                                      "so it takes no 'side', 'params' or 'value_map'");

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

  // Without a far end the window runs to the end of the body, which is the
  // cut every split makes; with one it stops there, which is how a local edit
  // becomes a local question.
  std::vector<llvm::Instruction *> window;
  if (to) {
    llvm::Instruction *last = refs.resolveInst(*to);
    if (!last)
      return errResponse("not_found", "'" + to->str() + "' does not exist");
    window = windowOf(*BB, cutInst, last);
    if (window.empty())
      return errResponse("invalid",
                         "'" + to->str() + "' does not come at or after '" + cut->str() + "'");
    if (window.back()->isTerminator())
      return errResponse("invalid", "a window cannot take the terminator with it; leave 'to' out "
                                    "to cut the suffix away instead");
  } else {
    window = suffixFrom(*BB, cutInst);
  }
  llvm::SmallPtrSet<llvm::Instruction *, 16> inside = setOf(window);

  // Nothing follows a suffix, so only a window can hand a value back, and it
  // can hand back one: a call answers with one value.
  std::vector<llvm::Instruction *> out = liveOutOf(window, inside);
  if (out.size() > 1) {
    std::string named;
    for (auto *I : out)
      named += (named.empty() ? "" : ", ") + refs.print(*I);
    return errResponse("invalid", "the window defines " + named +
                                      ", and the rest of the body uses them all; a call answers "
                                      "with one value");
  }

  std::vector<llvm::Value *> params;
  llvm::json::Array paramInfo;
  if (!side || *side == "src") {
    params = liveInto(*F, *BB, inside);
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

  llvm::json::Object resultInfo;
  if (!out.empty()) {
    std::string ty;
    llvm::raw_string_ostream os(ty);
    out.front()->getType()->print(os);
    resultInfo["type"] = std::move(ty);
    resultInfo["live"] = refs.print(*out.front());
  }

  llvm::Function *callee =
      moveOut(M, *F, *BB, window, inside, *calleeName, params, out.empty() ? nullptr : out.front());
  for (unsigned i = 0; i < paramInfo.size(); ++i)
    (*paramInfo[i].getAsObject())["param"] =
        "%" + std::next(callee->arg_begin(), i)->getName().str();

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["outer"] = printWithoutBody(M, callee->getName());
  resp["callee"] = printWithoutBody(M, F->getName());
  resp["params"] = std::move(paramInfo);
  if (!resultInfo.empty())
    resp["result"] = std::move(resultInfo);
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
