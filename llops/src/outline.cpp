#include "outline.h"

#include "detach.h"
#include "irutil.h"

#include "llvm/ADT/STLExtras.h"
#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/AsmParser/Parser.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/Cloning.h"
#include "llvm/Transforms/Utils/Local.h"
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

// The values a window uses from outside it, in definition order: instructions
// in the order they are printed first, then arguments. The order is what makes
// the signature reproducible from the program alone.
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

// Move a window into a fresh function and leave a call where it was. The
// callee hands back the values the rest of the body still uses: one as it is,
// several as a struct the outer takes apart right after the call.
llvm::Function *moveOut(llvm::Module &M, llvm::BasicBlock &BB,
                        llvm::ArrayRef<llvm::Instruction *> window,
                        const llvm::SmallPtrSetImpl<llvm::Instruction *> &inside,
                        llvm::StringRef calleeName, llvm::ArrayRef<llvm::Value *> params,
                        llvm::ArrayRef<llvm::Instruction *> results) {
  std::vector<llvm::Type *> paramTys;
  for (auto *v : params)
    paramTys.push_back(v->getType());
  std::vector<llvm::Type *> resultTys;
  for (auto *r : results)
    resultTys.push_back(r->getType());
  llvm::Type *retTy = results.empty()       ? llvm::Type::getVoidTy(M.getContext())
                      : results.size() == 1 ? resultTys.front()
                                            : llvm::StructType::get(M.getContext(), resultTys);
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
  for (unsigned k = 0; k < results.size(); ++k) {
    llvm::Value *answer = call;
    if (results.size() > 1)
      answer = llvm::ExtractValueInst::Create(call, {k}, "", window.front()->getIterator());
    std::vector<llvm::Use *> outside;
    for (llvm::Use &U : results[k]->uses()) {
      auto *user = llvm::dyn_cast<llvm::Instruction>(U.getUser());
      if (!user || !inside.contains(user))
        outside.push_back(&U);
    }
    for (auto *U : outside)
      U->set(answer);
  }

  calleeBB->splice(calleeBB->end(), &BB, window.front()->getIterator(),
                   std::next(window.back()->getIterator()));
  llvm::Value *answer = results.size() == 1 ? results.front() : nullptr;
  if (results.size() > 1) {
    answer = llvm::PoisonValue::get(retTy);
    for (unsigned k = 0; k < results.size(); ++k)
      answer = llvm::InsertValueInst::Create(answer, results[k], {k}, "", calleeBB);
  }
  llvm::ReturnInst::Create(M.getContext(), answer, calleeBB);
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

// The fields of a struct built one at a time from poison, as a window builds one, or nothing.
std::vector<llvm::Value *> partsOf(llvm::Value *v) {
  auto *ty = v ? llvm::dyn_cast<llvm::StructType>(v->getType()) : nullptr;
  if (!ty)
    return {};
  std::vector<llvm::Value *> parts(ty->getNumElements(), nullptr);
  while (auto *insert = llvm::dyn_cast<llvm::InsertValueInst>(v)) {
    unsigned k = insert->getIndices().front();
    if (insert->getNumIndices() != 1 || parts[k])
      return {};
    parts[k] = insert->getInsertedValueOperand();
    v = insert->getAggregateOperand();
  }
  if (!llvm::isa<llvm::PoisonValue>(v) || llvm::is_contained(parts, nullptr))
    return {};
  return parts;
}

// Whether every use of the call takes one field of it apart.
bool takenApart(llvm::CallInst &call, unsigned fields) {
  return llvm::all_of(call.users(), [&](llvm::User *user) {
    auto *part = llvm::dyn_cast<llvm::ExtractValueInst>(user);
    return part && part->getNumIndices() == 1 && part->getIndices().front() < fields;
  });
}

// Put a callee of several blocks back at a call its block returns, its entry joining that block.
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

// The outer once its callee is back, the declaration dropped and the program
// checked. A use left over would name the callee as something else.
llvm::json::Object inlined(llvm::Module &M, llvm::Function &decl) {
  if (!decl.use_empty())
    return errResponse("invalid", "'@" + decl.getName().str() + "' is used other than by the call");
  decl.eraseFromParent();
  if (auto d = departure(M))
    return errResponse(d->code, d->message);
  return moduleResponse(M);
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

  if (auto d = departure(M))
    return errResponse(d->code, d->message);
  llvm::Function *F = singleFunction(M);
  if (M.getNamedValue(*calleeName))
    return errResponse("invalid", "the name '@" + calleeName->str() + "' is already taken");
  ValueRefs refs(*F);
  llvm::Instruction *cutInst = refs.resolveInst(*cut);
  if (!cutInst)
    return errResponse("not_found", "the cut point '" + cut->str() + "' does not exist");
  // A cut takes the rest of the body; a window is a run of instructions in
  // one block, which is how a local edit becomes a local question.
  if (!to)
    return outlineRest(args, M, *F, refs, cutInst, *calleeName);
  llvm::BasicBlock *BB = cutInst->getParent();
  llvm::Instruction *last = refs.resolveInst(*to);
  if (!last)
    return errResponse("not_found", "'" + to->str() + "' does not exist");
  std::vector<llvm::Instruction *> window = windowOf(*BB, cutInst, last);
  if (window.empty())
    return errResponse("invalid", "'" + to->str() + "' does not come at or after '" + cut->str() +
                                      "' in its block");
  if (window.back()->isTerminator())
    return errResponse("invalid", "a window cannot take the terminator with it; leave 'to' out "
                                  "to cut the suffix away instead");
  if (llvm::isa<llvm::PHINode>(window.front()))
    return errResponse("invalid", "a window cannot take a phi, which belongs to its block");
  llvm::SmallPtrSet<llvm::Instruction *, 16> inside = setOf(window);
  std::vector<llvm::Instruction *> out = liveOutOf(window, inside);

  std::vector<llvm::Value *> params = liveInto(*F, inside);
  llvm::json::Array paramInfo;
  for (auto *v : params) {
    llvm::json::Object p;
    std::string ty;
    llvm::raw_string_ostream os(ty);
    v->getType()->print(os);
    p["type"] = std::move(ty);
    p["live"] = refs.print(*v);
    paramInfo.emplace_back(std::move(p));
  }

  // Named before the move, while the references still resolve in one body.
  llvm::json::Array live;
  for (auto *I : out)
    live.push_back(refs.print(*I));

  llvm::Function *callee = moveOut(M, *BB, window, inside, *calleeName, params, out);
  for (unsigned i = 0; i < paramInfo.size(); ++i)
    (*paramInfo[i].getAsObject())["param"] =
        "%" + std::next(callee->arg_begin(), i)->getName().str();

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["outer"] = printWithoutBody(M, callee->getName());
  resp["callee"] = printWithoutBody(M, F->getName());
  resp["params"] = std::move(paramInfo);
  if (!out.empty()) {
    std::string ty;
    llvm::raw_string_ostream os(ty);
    callee->getReturnType()->print(os);
    resp["result"] = llvm::json::Object{{"type", std::move(ty)}, {"live", std::move(live)}};
  }
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
  llvm::Function *F = singleFunction(outerM);
  if (!F)
    return errResponse("shape_error", "the outer module must define exactly one function");

  llvm::Function *decl = outerM.getFunction(*calleeName);
  if (!decl)
    return errResponse("not_found", "the outer does not call '@" + calleeName->str() + "'");
  llvm::CallInst *call = nullptr;
  for (auto &I : llvm::instructions(*F))
    if (auto *c = llvm::dyn_cast<llvm::CallInst>(&I))
      if (c->getCalledFunction() == decl) {
        if (call)
          return errResponse("invalid",
                             "the outer calls '@" + calleeName->str() + "' more than once");
        call = c;
      }
  if (!call)
    return errResponse("not_found", "the outer does not call '@" + calleeName->str() + "'");
  if (!plainCall(*call))
    return errResponse("invalid", "the call of '@" + calleeName->str() + "' is not a plain call");
  if (decl->getFunctionType() != callee->getFunctionType())
    return errResponse("type_mismatch", "the outer does not declare '@" + calleeName->str() +
                                            "' as the callee defines it");

  // The map covers both halves of the move: the callee's parameters become
  // the call's arguments, and every symbol the callee body names is redirected
  // to the outer module's own. A function the outer does not know is declared
  // there, which is what the callee's own declarations were.
  llvm::ValueToValueMapTy vmap;
  for (unsigned i = 0; i < callee->arg_size(); ++i)
    vmap[std::next(callee->arg_begin(), i)] = call->getArgOperand(i);
  llvm::json::Object adoptErr;
  if (!sharedSymbolsAgree(outerM, *F, *calleeMwc->mod, *callee, "", adoptErr))
    return adoptErr;
  if (!adoptSymbols(*calleeMwc->mod, outerM, callee, vmap, adoptErr))
    return adoptErr;

  if (callee->size() > 1) {
    if (!putBackRest(*call, *callee, *F, vmap))
      return errResponse("invalid", "a callee of several blocks goes back only at a call whose "
                                    "block returns what it answers");
    return inlined(outerM, *decl);
  }

  // Instructions move one by one instead of through LLVM's inliner, which
  // would hoist allocas to the entry block. The certificate checker compares
  // the result against the original program, so the order has to survive.
  llvm::BasicBlock *calleeBB = &callee->getEntryBlock();
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
    clone->insertInto(call->getParent(), call->getIterator());
    llvm::RemapInstruction(clone, vmap,
                           llvm::RF_IgnoreMissingLocals | llvm::RF_ReuseAndMutateDistinctMDs);
  }

  llvm::Value *retVal = llvm::cast<llvm::ReturnInst>(calleeBB->getTerminator())->getReturnValue();
  if (retVal) {
    auto it = vmap.find(retVal);
    if (it != vmap.end())
      retVal = it->second;
  }
  // A window that handed back several values answers with a struct the outer
  // takes apart at once, so each part goes back to where it is used.
  if (auto parts = partsOf(retVal); !parts.empty() && takenApart(*call, parts.size())) {
    for (auto *user : llvm::make_early_inc_range(call->users())) {
      auto *part = llvm::cast<llvm::ExtractValueInst>(user);
      part->replaceAllUsesWith(parts[part->getIndices().front()]);
      part->eraseFromParent();
    }
  }
  if (!call->getType()->isVoidTy())
    call->replaceAllUsesWith(retVal);
  call->eraseFromParent();
  if (auto *built = llvm::dyn_cast_or_null<llvm::Instruction>(retVal))
    llvm::RecursivelyDeleteTriviallyDeadInstructions(built);
  return inlined(outerM, *decl);
}

} // namespace llops
