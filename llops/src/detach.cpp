#include "detach.h"

#include "irutil.h"

#include "llvm/ADT/STLExtras.h"
#include "llvm/ADT/SetVector.h"
#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/IR/CFG.h"
#include "llvm/IR/InstIterator.h"
#include "llvm/IR/Instructions.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/BasicBlockUtils.h"
#include "llvm/Transforms/Utils/Cloning.h"
#include <optional>
#include <string>
#include <vector>

namespace llops {

namespace {

// B and every block it reaches, B first.
using Region = llvm::SetVector<llvm::BasicBlock *>;

// One successor slot of a terminator.
struct Edge {
  llvm::BasicBlock *from;
  unsigned index;
};

std::string operandName(const llvm::Value &V) {
  std::string out;
  llvm::raw_string_ostream os(out);
  V.printAsOperand(os, /*PrintType=*/false);
  return out;
}

llvm::BasicBlock *blockNamed(llvm::Function &F, llvm::StringRef ref) {
  ref = ref.trim();
  std::string wanted = ref.starts_with("%") ? ref.str() : "%" + ref.str();
  for (auto &B : F)
    if (operandName(B) == wanted)
      return &B;
  return nullptr;
}

Region reachedFrom(llvm::BasicBlock *B) {
  Region region;
  region.insert(B);
  for (unsigned i = 0; i < region.size(); ++i)
    for (llvm::BasicBlock *succ : llvm::successors(region[i]))
      region.insert(succ);
  return region;
}

// A block of the region that a block outside enters other than through B.
llvm::BasicBlock *secondEntry(llvm::Function &F, const Region &region) {
  for (auto &P : F)
    if (!region.contains(&P))
      for (llvm::BasicBlock *succ : llvm::successors(&P))
        if (succ != region.front() && region.contains(succ))
          return succ;
  return nullptr;
}

bool fromOutside(llvm::Value *v, const Region &region) {
  if (llvm::isa<llvm::Argument>(v))
    return true;
  auto *I = llvm::dyn_cast<llvm::Instruction>(v);
  return I && !region.contains(I->getParent());
}

// The values the region reads from outside, in definition order: instructions
// in layout order, then arguments. A phi of B reads on a back edge only; what
// it takes on an edge from outside is an argument of the call there.
std::vector<llvm::Value *> readFromOutside(llvm::Function &F, const Region &region) {
  llvm::SmallPtrSet<llvm::Value *, 32> read;
  for (llvm::BasicBlock *R : region)
    for (auto &I : *R) {
      auto *phi = llvm::dyn_cast<llvm::PHINode>(&I);
      if (phi && R == region.front()) {
        for (unsigned i = 0; i < phi->getNumIncomingValues(); ++i)
          if (region.contains(phi->getIncomingBlock(i)))
            read.insert(phi->getIncomingValue(i));
        continue;
      }
      for (const llvm::Use &U : I.operands())
        read.insert(U.get());
    }
  std::vector<llvm::Value *> live;
  for (auto &O : F)
    if (!region.contains(&O))
      for (auto &I : O)
        if (read.contains(&I))
          live.push_back(&I);
  for (auto &arg : F.args())
    if (read.contains(&arg))
      live.push_back(&arg);
  return live;
}

// What detaching B has to pass: B's phis, then what the region reads from outside.
std::vector<llvm::Value *> needed(llvm::Function &F, const Region &region) {
  std::vector<llvm::Value *> params;
  for (auto &phi : region.front()->phis())
    params.push_back(&phi);
  auto live = readFromOutside(F, region);
  params.insert(params.end(), live.begin(), live.end());
  return params;
}

// The tgt signature: each src entry resolved through the value map to a phi of
// B or a value from outside, and nothing the tgt needs left out.
bool tgtParams(llvm::json::Object &args, llvm::Function &F, ValueRefs &refs, const Region &region,
               std::vector<llvm::Value *> &params, llvm::json::Object &err) {
  auto *spec = args.getArray("params");
  auto *valueMap = args.getObject("value_map");
  if (!spec || !valueMap) {
    err = errResponse("bad_request", "a tgt detach needs 'params' and 'value_map'");
    return false;
  }
  for (const auto &entry : *spec) {
    llvm::Value *v = mappedParam(entry, *valueMap, F, refs, err);
    if (!v)
      return false;
    auto *phi = llvm::dyn_cast<llvm::PHINode>(v);
    if (!(phi && phi->getParent() == region.front()) && !fromOutside(v, region)) {
      err = errResponse("invalid", "value_map: '" + refs.print(*v) +
                                       "' is neither a phi of the block nor defined before it");
      return false;
    }
    params.push_back(v);
  }
  for (llvm::Value *v : needed(F, region))
    if (!llvm::is_contained(params, v)) {
      err = errResponse("invalid", "the tgt region uses '" + refs.print(*v) +
                                       "', which the value map does not cover");
      return false;
    }
  return true;
}

std::vector<Edge> edgesInto(llvm::Function &F, llvm::BasicBlock *B) {
  std::vector<Edge> edges;
  for (auto &P : F)
    if (auto *term = P.getTerminator())
      for (unsigned i = 0; i < term->getNumSuccessors(); ++i)
        if (term->getSuccessor(i) == B)
          edges.push_back({&P, i});
  return edges;
}

// Route one edge into a fresh block that calls `target` with what the
// parameters are on that edge, and returns what it answers. On a back edge
// from inside `k`, a parameter that is not a phi passes itself on, even when
// the tgt's value map made one value two parameters.
llvm::BasicBlock *callInstead(Edge e, llvm::BasicBlock *B, llvm::Function *target,
                              llvm::ArrayRef<llvm::Value *> params, llvm::Function *k) {
  std::vector<llvm::Value *> args;
  for (unsigned i = 0; i < params.size(); ++i) {
    auto *phi = llvm::dyn_cast<llvm::PHINode>(params[i]);
    if (phi && phi->getParent() == B)
      args.push_back(phi->getIncomingValueForBlock(e.from));
    else
      args.push_back(k ? k->getArg(i) : params[i]);
  }
  llvm::Function *F = e.from->getParent();
  auto *Q = llvm::BasicBlock::Create(F->getContext(), "", F);
  auto *call = llvm::CallInst::Create(target, args, "", Q);
  llvm::ReturnInst::Create(F->getContext(), call->getType()->isVoidTy() ? nullptr : call, Q);
  e.from->getTerminator()->setSuccessor(e.index, Q);
  return Q;
}

// Move the region into `name`, routing every edge into B through a call: of
// `name` from outside, of `hypothesis` from inside. Returns the new function
// and whether a back edge made it call its hypothesis.
llvm::Function *cutOut(llvm::Module &M, llvm::Function &F, const Region &region,
                       llvm::ArrayRef<llvm::Value *> params, llvm::StringRef name,
                       llvm::StringRef hypothesis, bool &recurses) {
  llvm::BasicBlock *B = region.front();
  std::vector<llvm::Type *> types;
  for (llvm::Value *p : params)
    types.push_back(p->getType());
  auto *type = llvm::FunctionType::get(F.getReturnType(), types, /*isVarArg=*/false);
  auto *k = llvm::Function::Create(type, llvm::Function::ExternalLinkage, name, &M);
  llvm::Function *ih = nullptr;

  Region moving = region;
  for (Edge e : edgesInto(F, B)) {
    bool back = region.contains(e.from);
    if (back && !ih)
      ih = llvm::Function::Create(type, llvm::Function::ExternalLinkage, hypothesis, &M);
    llvm::BasicBlock *Q = callInstead(e, B, back ? ih : k, params, back ? k : nullptr);
    if (back)
      moving.insert(Q);
  }
  recurses = ih != nullptr;

  for (llvm::BasicBlock *R : moving) {
    R->removeFromParent();
    R->insertInto(k);
  }
  llvm::DenseMap<llvm::Value *, llvm::Value *> toParam;
  for (unsigned i = 0; i < params.size(); ++i)
    toParam[params[i]] = k->getArg(i);
  for (auto &I : llvm::instructions(*k))
    for (llvm::Use &U : I.operands())
      if (auto it = toParam.find(U.get()); it != toParam.end())
        U.set(it->second);
  for (auto &phi : llvm::make_early_inc_range(B->phis()))
    phi.eraseFromParent();
  for (unsigned i = 0; i < params.size(); ++i)
    k->getArg(i)->setName("p" + std::to_string(i));
  return k;
}

// One half of the detach: the module with `bodyless` reduced to a declaration,
// and `gone` dropped once nothing calls it.
std::unique_ptr<llvm::Module> half(llvm::Module &M, llvm::StringRef bodyless,
                                   llvm::StringRef gone) {
  llvm::ValueToValueMapTy vmap;
  auto clone = llvm::CloneModule(M, vmap);
  llvm::Function *drop = clone->getFunction(bodyless);
  drop->deleteBody();
  drop->setAttributes(llvm::AttributeList());
  if (auto *unused = clone->getFunction(gone); unused && unused->use_empty())
    unused->eraseFromParent();
  return clone;
}

// A block that only calls one of `targets` and returns what it answers.
llvm::CallInst *onlyCalls(llvm::BasicBlock &Q, llvm::ArrayRef<llvm::Function *> targets) {
  if (Q.size() != 2)
    return nullptr;
  auto *call = llvm::dyn_cast<llvm::CallInst>(&Q.front());
  auto *ret = llvm::dyn_cast<llvm::ReturnInst>(Q.getTerminator());
  if (!call || !ret || !llvm::is_contained(targets, call->getCalledFunction()))
    return nullptr;
  if (ret->getReturnValue() != (call->getType()->isVoidTy() ? nullptr : call))
    return nullptr;
  return call;
}

// The positions of the parameters that are B's phis.
llvm::json::Array phiPositions(llvm::ArrayRef<llvm::Value *> params, llvm::BasicBlock *B) {
  llvm::json::Array positions;
  for (unsigned i = 0; i < params.size(); ++i)
    if (auto *phi = llvm::dyn_cast<llvm::PHINode>(params[i]); phi && phi->getParent() == B)
      positions.push_back(i);
  return positions;
}

// Which of `count` parameters `list` names as phis, or nothing when it names
// a position the callee does not have.
std::optional<std::vector<bool>> phiParams(const llvm::json::Array &list, unsigned count) {
  std::vector<bool> isPhi(count, false);
  for (const auto &entry : list) {
    auto i = entry.getAsInteger();
    if (!i || *i < 0 || *i >= count)
      return std::nullopt;
    isPhi[*i] = true;
  }
  return isPhi;
}

// Move `region` into `name` and answer with the two halves; `joined` takes back the call.
llvm::json::Object moveRegion(llvm::json::Object &args, llvm::Module &M, llvm::Function &F,
                              ValueRefs &refs, const Region &region, llvm::StringRef name,
                              llvm::BasicBlock *joined) {
  std::vector<llvm::Value *> params;
  llvm::json::Array paramInfo;
  if (args.getString("side") == "src") {
    params = needed(F, region);
    for (llvm::Value *v : params) {
      llvm::json::Object p;
      std::string type;
      llvm::raw_string_ostream os(type);
      v->getType()->print(os);
      p["type"] = std::move(type);
      p["live"] = refs.print(*v);
      paramInfo.emplace_back(std::move(p));
    }
  } else {
    llvm::json::Object err;
    if (!tgtParams(args, F, refs, region, params, err))
      return err;
    paramInfo = *args.getArray("params");
  }

  auto phis = phiPositions(params, region.front());
  std::string hypothesis = name.str() + ".ih";
  bool recurses = false;
  llvm::Function *k = cutOut(M, F, region, params, name, hypothesis, recurses);
  for (unsigned i = 0; i < paramInfo.size(); ++i)
    (*paramInfo[i].getAsObject())["param"] = "%" + k->getArg(i)->getName().str();
  if (joined)
    llvm::MergeBlockIntoPredecessor(joined->getSingleSuccessor());

  auto outer = half(M, k->getName(), hypothesis);
  auto callee = half(M, F.getName(), "");
  for (llvm::Module *view : {outer.get(), callee.get()})
    if (auto d = departure(*view))
      return errResponse(d->code, d->message);

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["outer"] = printModule(*outer);
  resp["callee"] = printModule(*callee);
  resp["params"] = std::move(paramInfo);
  if (!joined)
    resp["phis"] = std::move(phis);
  if (recurses)
    resp["hypothesis"] = hypothesis;
  return resp;
}

// The error for a region entered other than through its first block.
llvm::json::Object secondEntryError(llvm::BasicBlock &other) {
  return errResponse("not_single_entry",
                     "'" + operandName(other) +
                         "' is entered from outside the blocks the cut reaches; cut there first");
}

} // namespace

llvm::json::Object detachCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  auto block = args.getString("block");
  auto name = args.getString("callee");
  auto side = args.getString("side");
  if (!text || !block || !name)
    return errResponse("bad_request", "detach needs 'module', 'block' and 'callee'");
  if (!side || (*side != "src" && *side != "tgt"))
    return errResponse("bad_request", "detach needs 'side' (src|tgt)");

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);
  llvm::Module &M = *mwc->mod;
  if (auto d = departure(M))
    return errResponse(d->code, d->message);
  llvm::Function *F = singleFunction(M);
  if (M.getNamedValue(*name) || M.getNamedValue(name->str() + ".ih"))
    return errResponse("invalid", "the name '@" + name->str() + "' or '@" + name->str() +
                                      ".ih' is already taken");

  llvm::BasicBlock *B = blockNamed(*F, *block);
  if (!B)
    return errResponse("not_found", "no block '" + block->str() + "'");
  if (B == &F->getEntryBlock())
    return errResponse("invalid", "nothing branches to the entry block; cut at an instruction");
  Region region = reachedFrom(B);
  if (llvm::BasicBlock *other = secondEntry(*F, region))
    return secondEntryError(*other);
  ValueRefs refs(*F);
  return moveRegion(args, M, *F, refs, region, *name, nullptr);
}

llvm::json::Object outlineRest(llvm::json::Object &args, llvm::Module &M, llvm::Function &F,
                               ValueRefs &refs, llvm::Instruction *cut, llvm::StringRef name) {
  if (llvm::isa<llvm::PHINode>(cut))
    return errResponse("invalid", "a cut at a phi leaves the other phis behind; cut at the block");
  // `refs` was read before the split, which names its new block so that it
  // takes no slot of its own.
  llvm::BasicBlock *head = cut->getParent();
  Region region = reachedFrom(head->splitBasicBlock(cut, "rest"));
  if (llvm::BasicBlock *other = secondEntry(F, region))
    return secondEntryError(*other);
  return moveRegion(args, M, F, refs, region, name, head);
}

llvm::json::Object reattachCmd(llvm::json::Object &args) {
  auto outerText = args.getString("outer");
  auto calleeText = args.getString("callee");
  auto name = args.getString("callee_name");
  auto hypothesis = args.getString("hypothesis");
  auto *phiList = args.getArray("phis");
  if (!outerText || !calleeText || !name || !phiList)
    return errResponse("bad_request", "reattach needs 'outer', 'callee', 'callee_name' and 'phis'");

  std::string parseErr;
  auto outerMwc = parseModule(*outerText, &parseErr);
  if (!outerMwc)
    return errResponse("parse_error", "outer: " + parseErr);
  auto calleeMwc = parseModule(*calleeText, &parseErr, *outerMwc->ctx);
  if (!calleeMwc)
    return errResponse("parse_error", "callee: " + parseErr);
  llvm::Module &outerM = *outerMwc->mod;
  llvm::Function *F = singleFunction(outerM);
  if (!F)
    return errResponse("shape_error", "the outer module must define exactly one function");
  llvm::Function *K = calleeMwc->mod->getFunction(*name);
  if (!K || K->isDeclaration())
    return errResponse("not_found", "'@" + name->str() + "' is not defined in the callee module");
  llvm::Function *decl = outerM.getFunction(*name);
  if (!decl || decl->getFunctionType() != K->getFunctionType())
    return errResponse("type_mismatch", "the outer does not declare '@" + name->str() +
                                            "' as the callee defines it");
  auto isPhi = phiParams(*phiList, K->arg_size());
  if (!isPhi)
    return errResponse("bad_request", "'phis' names a parameter the callee does not have");

  llvm::ValueToValueMapTy vmap;
  llvm::json::Object err;
  if (!sharedSymbolsAgree(outerM, *F, *calleeMwc->mod, *K, hypothesis ? *hypothesis : "", err))
    return err;
  if (!adoptSymbols(*calleeMwc->mod, outerM, K, vmap, err))
    return err;
  llvm::Function *ih = hypothesis ? outerM.getFunction(*hypothesis) : nullptr;
  if (ih && ih->getFunctionType() != K->getFunctionType())
    return errResponse("type_mismatch", "'@" + hypothesis->str() + "' is not declared as '@" +
                                            name->str() + "' is defined");

  // The callee's blocks come back, its entry first, with its parameters as
  // phis there that the calls below fill in.
  std::vector<llvm::BasicBlock *> blocks;
  for (auto &B : *K) {
    auto *moved = llvm::BasicBlock::Create(outerM.getContext(), B.getName(), F);
    vmap[&B] = moved;
    blocks.push_back(moved);
  }
  llvm::BasicBlock *entry = blocks.front();
  std::vector<llvm::PHINode *> phis;
  for (auto &arg : K->args()) {
    auto *phi = llvm::PHINode::Create(arg.getType(), 0, "", entry);
    vmap[&arg] = phi;
    phis.push_back(phi);
  }
  std::vector<llvm::Instruction *> clones;
  unsigned b = 0;
  for (auto &B : *K) {
    for (auto &I : B) {
      auto *clone = I.clone();
      clone->setName(I.getName());
      clone->insertInto(blocks[b], blocks[b]->end());
      vmap[&I] = clone;
      clones.push_back(clone);
    }
    ++b;
  }
  for (auto *clone : clones)
    llvm::RemapInstruction(clone, vmap,
                           llvm::RF_IgnoreMissingLocals | llvm::RF_ReuseAndMutateDistinctMDs);

  // Every block that only calls `k` or its hypothesis was an edge into the
  // callee's entry, carrying the parameters' values on that edge.
  std::vector<llvm::BasicBlock *> calls;
  std::vector<llvm::Function *> targets = {decl};
  if (ih)
    targets.push_back(ih);
  for (auto &Q : *F)
    if (onlyCalls(Q, targets))
      calls.push_back(&Q);
  if (calls.empty())
    return errResponse("not_found", "no block only calls '@" + name->str() + "'");
  for (llvm::BasicBlock *Q : calls) {
    if (Q == &F->getEntryBlock())
      return errResponse("invalid", "the outer's entry only calls '@" + name->str() +
                                        "', which is outline's suffix, not a detached block");
    llvm::CallInst *call = onlyCalls(*Q, targets);
    if (!plainCall(*call))
      return errResponse("invalid", "the call of '@" + call->getCalledFunction()->getName().str() +
                                        "' is not a plain call");
    for (Edge e : edgesInto(*F, Q)) {
      e.from->getTerminator()->setSuccessor(e.index, entry);
      for (unsigned i = 0; i < phis.size(); ++i)
        phis[i]->addIncoming(call->getArgOperand(i), e.from);
    }
  }
  for (llvm::BasicBlock *Q : calls)
    Q->eraseFromParent();

  // A parameter that was not one of the block's phis was a value from
  // outside, which every edge passes as that value or as itself.
  for (unsigned i = 0; i < phis.size(); ++i) {
    if ((*isPhi)[i] || phis[i]->getNumIncomingValues() == 0)
      continue;
    llvm::Value *same = phis[i]->hasConstantValue();
    if (!same)
      return errResponse("invalid", "parameter " + std::to_string(i) +
                                        " is not a phi, yet the calls pass it different values");
    phis[i]->replaceAllUsesWith(same);
    phis[i]->eraseFromParent();
  }
  for (llvm::Function *target : targets)
    if (target->use_empty())
      target->eraseFromParent();

  if (auto d = departure(outerM))
    return errResponse(d->code, d->message);
  return moduleResponse(outerM);
}

} // namespace llops
