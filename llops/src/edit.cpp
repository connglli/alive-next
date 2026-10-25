#include "edit.h"

#include "irutil.h"
#include "respected.h"
#include "snippet.h"

#include "llvm/ADT/STLExtras.h"
#include "llvm/ADT/SetVector.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/Analysis/LoopInfo.h"
#include "llvm/AsmParser/LLLexer.h"
#include "llvm/AsmParser/Parser.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/Dominators.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Operator.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/Cloning.h"
#include "llvm/Transforms/Utils/Local.h"
#include "llvm/Transforms/Utils/ValueMapper.h"
#include <string>
#include <vector>

namespace llops {

namespace {

// Whether `def` is available at every use of `v`, uses in phis included.
bool reachesEveryUse(llvm::Value *def, llvm::Value *v) {
  auto *I = llvm::dyn_cast<llvm::Instruction>(def);
  if (!I)
    return true;
  llvm::DominatorTree DT(*I->getFunction());
  return llvm::all_of(v->uses(),
                      [&](const llvm::Use &U) { return U.getUser() != I && DT.dominates(I, U); });
}

// The block of F that `ref` names as F prints it, or nullptr.
llvm::BasicBlock *blockNamed(llvm::Function &F, ValueRefs &refs, llvm::StringRef ref) {
  for (llvm::BasicBlock &B : F)
    if (refs.print(B) == ref.trim())
      return &B;
  return nullptr;
}

// What `blocks` define that is used outside them, or nullptr. A phi on an edge
// from them does not count, since it can take a copy's value from the copy.
const llvm::Instruction *usedAfter(llvm::ArrayRef<llvm::BasicBlock *> blocks) {
  for (llvm::BasicBlock *B : blocks)
    for (llvm::Instruction &I : *B)
      for (llvm::Use &U : I.uses()) {
        auto *user = llvm::cast<llvm::Instruction>(U.getUser());
        auto *phi = llvm::dyn_cast<llvm::PHINode>(user);
        auto *from = phi ? phi->getIncomingBlock(U) : user->getParent();
        if (!llvm::is_contained(blocks, from) && !llvm::is_contained(blocks, user->getParent()))
          return &I;
      }
  return nullptr;
}

// Where a conversion for use `U` goes: before its user, or ending a phi's incoming block.
llvm::BasicBlock::iterator beforeUse(const llvm::Use &U) {
  auto *user = llvm::cast<llvm::Instruction>(U.getUser());
  if (auto *phi = llvm::dyn_cast<llvm::PHINode>(user))
    return phi->getIncomingBlock(U)->getTerminator()->getIterator();
  return user->getIterator();
}

// The globals a value names, through the constants it is built from.
void globalsOf(llvm::Value *v, llvm::SmallPtrSetImpl<llvm::GlobalValue *> &out) {
  if (auto *gv = llvm::dyn_cast<llvm::GlobalValue>(v)) {
    out.insert(gv);
    return;
  }
  if (auto *c = llvm::dyn_cast<llvm::Constant>(v))
    for (llvm::Use &U : c->operands())
      globalsOf(U.get(), out);
}

// Point the global names a window uses at the globals of `into`, and declare
// any function `into` lacks. Only names the window uses are taken, so no unused
// declaration is added.
bool adoptWindowSymbols(llvm::ArrayRef<llvm::Instruction *> window, llvm::Module &into,
                        llvm::ValueToValueMapTy &vmap, RenamedTypes &renamed,
                        llvm::json::Object &err) {
  llvm::SmallPtrSet<llvm::GlobalValue *, 8> named;
  for (auto *I : window)
    for (llvm::Use &U : I->operands())
      globalsOf(U.get(), named);
  for (llvm::GlobalValue *gv : named) {
    llvm::GlobalValue *mine = into.getNamedValue(gv->getName());
    if (!mine) {
      auto *fn = llvm::dyn_cast<llvm::Function>(gv);
      if (!fn) {
        err = errResponse("not_found", "splice: the window refers to '@" + gv->getName().str() +
                                           "', which the module does not have");
        return false;
      }
      auto *type = llvm::cast<llvm::FunctionType>(renamed.remapType(fn->getFunctionType()));
      auto *decl = llvm::Function::Create(type, fn->getLinkage(), fn->getName(), &into);
      decl->setAttributes(renamed.remap(fn->getAttributes(), into.getContext()));
      mine = decl;
    }
    if (mine->getType() != gv->getType() ||
        mine->getValueType() != renamed.remapType(gv->getValueType())) {
      err = errResponse("type_mismatch", "splice: '@" + gv->getName().str() +
                                             "' has another type in the two modules");
      return false;
    }
    vmap[gv] = mine;
  }
  return true;
}

// Replace a window of this module with a copy of a window of another module.
// The value map gives each value of this module a partner in the other.
llvm::json::Object splice(llvm::json::Object &args, CmdShape &shape) {
  auto from = args.getString("from");
  auto to = args.getString("to");
  auto *with = args.getObject("with");
  auto *map = args.getObject("value_map");
  auto otherText = with ? with->getString("module") : std::nullopt;
  auto otherFrom = with ? with->getString("from") : std::nullopt;
  auto otherTo = with ? with->getString("to") : std::nullopt;
  if (!from || !to || !map || !otherText || !otherFrom || !otherTo)
    return errResponse("bad_request", "splice needs 'from', 'to', 'value_map' and 'with', which "
                                      "needs 'module', 'from' and 'to'");
  // The other module is parsed into the same context, so the two share types
  // and constants and only their own values need mapping.
  std::string parseErr;
  auto otherMwc = parseModule(*otherText, &parseErr, *shape.mwc->ctx);
  if (!otherMwc)
    return errResponse("parse_error", "splice: with: " + parseErr);
  if (auto d = departure(*otherMwc->mod))
    return errResponse(d->code, "splice: with: " + d->message);
  llvm::Module &M = *shape.M;
  llvm::Function &F = *shape.F;
  llvm::Function &G = *singleFunction(*otherMwc->mod);
  ValueRefs &refs = *shape.refs;
  ValueRefs otherRefs(G);

  llvm::json::Object err;
  auto windowAt = [&](ValueRefs &r, llvm::StringRef a, llvm::StringRef b) {
    llvm::Instruction *first = r.resolveInst(a);
    llvm::Instruction *last = r.resolveInst(b);
    if (!first || !last) {
      err = errResponse("not_found", "splice: '" + (first ? b : a).str() + "' does not exist");
      return std::vector<llvm::Instruction *>{};
    }
    return windowBetween(first, last, a, b, "", err);
  };
  std::vector<llvm::Instruction *> window = windowAt(refs, *from, *to);
  if (window.empty())
    return err;
  std::vector<llvm::Instruction *> theirs = windowAt(otherRefs, *otherFrom, *otherTo);
  if (theirs.empty())
    return err;
  llvm::SmallPtrSet<llvm::Instruction *, 16> inside = setOf(window);
  llvm::SmallPtrSet<llvm::Instruction *, 16> theirsInside = setOf(theirs);

  // Each value of this module and its partner in the other, both ways.
  llvm::DenseMap<llvm::Value *, llvm::Value *> standsFor;
  llvm::DenseMap<llvm::Value *, llvm::Value *> standsIn;
  for (const auto &[key, val] : *map) {
    auto other = val.getAsString();
    llvm::Value *mine = refs.resolve(key);
    llvm::Value *theirsValue = other ? otherRefs.resolve(*other) : nullptr;
    if (!mine || !theirsValue)
      return errResponse("not_found", "splice: value_map: '" + key.str() +
                                          "' or what it maps to does not exist");
    if (mine->getType() != otherMwc->renamed.remapType(theirsValue->getType()))
      return errResponse("type_mismatch", "splice: value_map: '" + key.str() + "' and '" +
                                              other->str() + "' have different types");
    standsFor[mine] = theirsValue;
    auto [it, fresh] = standsIn.try_emplace(theirsValue, mine);
    if (!fresh && it->second != mine)
      return errResponse("invalid", "splice: value_map gives '" + other->str() + "' two partners");
  }

  // Every value the copy reads from outside its window needs a partner here.
  llvm::ValueToValueMapTy vmap;
  for (llvm::Value *read : liveInto(G, theirsInside)) {
    auto it = standsIn.find(read);
    if (it == standsIn.end())
      return errResponse("invalid", "splice: the copy reads '" + otherRefs.print(*read) +
                                        "', which has no partner in the value map");
    vmap[read] = it->second;
  }
  if (!adoptWindowSymbols(theirs, M, vmap, otherMwc->renamed, err))
    return err;

  // The copy goes where the replaced window starts.
  std::vector<llvm::Instruction *> copies;
  for (auto *I : theirs) {
    auto *copy = I->clone();
    copy->setName(I->getName());
    copy->insertBefore(window.front()->getIterator());
    vmap[I] = copy;
    copies.push_back(copy);
  }
  for (auto *copy : copies)
    llvm::RemapInstruction(copy, vmap,
                           llvm::RF_IgnoreMissingLocals | llvm::RF_ReuseAndMutateDistinctMDs,
                           &otherMwc->renamed);

  // A later use of a replaced value takes its partner instead: a copied value,
  // or a value of this module that the copy reads.
  for (auto *I : liveOutOf(F, window, inside)) {
    auto it = standsFor.find(I);
    llvm::Value *now = nullptr;
    if (it != standsFor.end()) {
      if (auto *theirsInst = llvm::dyn_cast<llvm::Instruction>(it->second);
          theirsInst && theirsInside.contains(theirsInst))
        now = vmap[theirsInst];
      else if (auto in = standsIn.find(it->second); in != standsIn.end() && in->second != I)
        now = in->second;
    }
    if (!now)
      return errResponse("invalid", "splice: '" + refs.print(*I) +
                                        "' is used after the window but has no partner in the "
                                        "value map");
    std::vector<llvm::Use *> outside;
    for (llvm::Use &U : I->uses())
      if (!inside.contains(llvm::cast<llvm::Instruction>(U.getUser())))
        outside.push_back(&U);
    for (auto *U : outside)
      U->set(now);
  }
  for (auto *I : llvm::reverse(window))
    I->eraseFromParent();
  return checkedResponse(M);
}

} // namespace

// ---------------------------------------------------------------------------
// The op catalog
// ---------------------------------------------------------------------------

llvm::json::Object editCmd(llvm::json::Object &args) {
  auto op = args.getString("op");
  if (!op)
    return errResponse("bad_request", "edit needs 'op'");

  CmdShape shape;
  llvm::json::Object shapeErr;
  if (!parseCmdShape(args, "edit", shape, shapeErr))
    return shapeErr;
  llvm::Module *M = shape.M;
  llvm::Function *F = shape.F;
  ValueRefs refs(*F);

  auto missing = [&](llvm::StringRef what) {
    return errResponse("bad_request", op->str() + " needs " + what.str());
  };

  if (*op == "splice")
    return splice(args, shape);

  if (*op == "swap") {
    auto a = args.getString("a");
    auto b = args.getString("b");
    if (!a || !b)
      return missing("'a' and 'b'");
    llvm::Instruction *ai = refs.resolveInst(*a);
    llvm::Instruction *bi = refs.resolveInst(*b);
    if (!ai || !bi)
      return errResponse("not_found", "swap: unknown instruction");
    if (ai == bi)
      return errResponse("invalid", "swap: an instruction cannot swap with itself");
    if (ai->isTerminator() || bi->isTerminator())
      return errResponse("invalid", "swap: the terminator cannot move");
    llvm::BasicBlock *BB = ai->getParent();
    if (bi->getParent() != BB)
      return errResponse("invalid", "swap: the two instructions are in different blocks");
    // Exchange the two positions: put the later one where the earlier sits,
    // then put the earlier one where the later sat.
    llvm::Instruction *first = ai->comesBefore(bi) ? ai : bi;
    llvm::Instruction *second = first == ai ? bi : ai;
    auto afterSecond = std::next(second->getIterator());
    BB->splice(first->getIterator(), BB, second->getIterator());
    BB->splice(afterSecond, BB, first->getIterator());
    return checkedResponse(*M);
  }

  if (*op == "move") {
    auto v = args.getString("v");
    auto where = args.getString("where");
    auto w = args.getString("w");
    if (!v || !w || !where || (*where != "before" && *where != "after"))
      return missing("'v', 'where' (before|after) and 'w'");
    llvm::Instruction *vi = refs.resolveInst(*v);
    llvm::Instruction *wi = refs.resolveInst(*w);
    if (!vi || !wi)
      return errResponse("not_found", "move: unknown instruction");
    if (vi == wi)
      return errResponse("invalid", "move: an instruction cannot move relative to itself");
    if (vi->isTerminator())
      return errResponse("invalid", "move: the terminator cannot move");
    if (wi->isTerminator() && *where == "after")
      return errResponse("invalid", "move: nothing comes after the terminator");
    wi->getParent()->splice(*where == "before" ? wi->getIterator() : std::next(wi->getIterator()),
                            vi->getParent(), vi->getIterator());
    return checkedResponse(*M);
  }

  if (*op == "substitute") {
    auto a = args.getString("a");
    auto b = args.getString("b");
    if (!a || !b)
      return missing("'a' and 'b'");
    llvm::Value *va = refs.resolve(*a);
    llvm::Value *vb = refs.resolve(*b);
    if (!va || !vb)
      return errResponse("not_found", "substitute: unknown value");
    if (va == vb)
      return errResponse("invalid", "substitute: the two values are the same");
    if (va->getType() != vb->getType())
      return errResponse("type_mismatch", "substitute: the values have different types");
    // '%b' has to reach every use of '%a', and a use inside '%b' itself would
    // make '%b' its own operand.
    if (!reachesEveryUse(vb, va))
      return errResponse("dominance", "substitute: '" + refs.print(*vb) +
                                          "' does not reach every use of '" + refs.print(*va) +
                                          "'");
    va->replaceAllUsesWith(vb);
    return checkedResponse(*M);
  }

  if (*op == "replace") {
    auto v = args.getString("v");
    auto insts = args.getArray("insts");
    if (!v || !insts)
      return missing("'v' and 'insts'");
    llvm::Instruction *oldDef = refs.resolveInst(*v);
    if (!oldDef)
      return errResponse("not_found", "replace: unknown instruction");
    if (oldDef->isTerminator())
      return errResponse("invalid", "replace: the terminator cannot be replaced");
    std::string snippet;
    llvm::json::Object err;
    if (!joinInsts(*insts, snippet, err))
      return err;

    Snippet s;
    if (!parseSnippet(*F, refs, snippet, oldDef, SnippetScope{}, s, err))
      return err;
    llvm::Instruction *last = s.insts.back();
    if (oldDef->getType() != last->getType()) {
      for (auto *inst : s.insts)
        inst->deleteValue();
      return errResponse("type_mismatch",
                         "replace: the last snippet instruction has a different type");
    }
    // The old definition is going away, so its name is free for the snippet
    // to reuse; clearing it first also stops LLVM from renaming the new one.
    std::string oldName = oldDef->getName().str();
    oldDef->setName("");
    for (auto *inst : s.insts)
      inst->insertInto(oldDef->getParent(), oldDef->getIterator());
    if (!oldDef->getType()->isVoidTy())
      oldDef->replaceAllUsesWith(last);
    oldDef->eraseFromParent();
    if (last->getName().empty())
      last->setName(oldName);
    return checkedResponse(*M);
  }

  if (*op == "insert") {
    auto where = args.getString("where");
    auto w = args.getString("w");
    auto insts = args.getArray("insts");
    if (!w || !insts || !where || (*where != "before" && *where != "after"))
      return missing("'where' (before|after), 'w' and 'insts'");
    llvm::Instruction *wi = refs.resolveInst(*w);
    if (!wi)
      return errResponse("not_found", "insert: unknown anchor");
    if (wi->isTerminator() && *where == "after")
      return errResponse("invalid", "insert: nothing comes after the terminator");
    std::string snippet;
    llvm::json::Object err;
    if (!joinInsts(*insts, snippet, err))
      return err;
    Snippet s;
    if (!parseSnippet(*F, refs, snippet, nullptr, SnippetScope{}, s, err))
      return err;
    auto pos = *where == "before" ? wi->getIterator() : std::next(wi->getIterator());
    for (auto *inst : s.insts)
      inst->insertInto(wi->getParent(), pos);
    return checkedResponse(*M);
  }

  if (*op == "erase") {
    auto v = args.getString("v");
    if (!v)
      return missing("'v'");
    bool cascade = args.getBoolean("cascade").value_or(false);
    llvm::Instruction *vi = refs.resolveInst(*v);
    if (!vi)
      return errResponse("not_found", "erase: unknown instruction");
    if (vi->isTerminator())
      return errResponse("invalid", "erase: the terminator cannot be erased");
    if (!vi->use_empty())
      return errResponse("used", "erase: '" + refs.print(*vi) +
                                     "' is still used; erase or rewrite its users first");
    if (cascade) {
      // The helper stops at anything with side effects, so a cascade never
      // silently drops a store or a call.
      llvm::RecursivelyDeleteTriviallyDeadInstructions(vi);
    } else {
      vi->eraseFromParent();
    }
    return checkedResponse(*M);
  }

  if (*op == "commute") {
    auto v = args.getString("v");
    if (!v)
      return missing("'v'");
    llvm::Instruction *vi = refs.resolveInst(*v);
    if (!vi)
      return errResponse("not_found", "commute: unknown instruction");
    if (auto *bo = llvm::dyn_cast<llvm::BinaryOperator>(vi)) {
      if (!bo->isCommutative())
        return errResponse("invalid", "commute: the operation is not commutative");
      bo->swapOperands();
    } else if (auto *cmp = llvm::dyn_cast<llvm::CmpInst>(vi)) {
      // Swapping the operands of a comparison also swaps the predicate, so
      // this holds for every predicate, not just the commutative ones.
      cmp->swapOperands();
    } else {
      return errResponse("invalid", "commute: the operation is not commutative");
    }
    return checkedResponse(*M);
  }

  if (*op == "retype") {
    auto v = args.getString("v");
    auto ty = args.getString("ty");
    if (!v || !ty)
      return missing("'v' and 'ty'");
    llvm::StringRef ext = args.getString("ext").value_or("zext");
    if (ext != "zext" && ext != "sext")
      return errResponse("bad_request", "retype: 'ext' must be 'zext' or 'sext'");
    llvm::Instruction *vi = refs.resolveInst(*v);
    if (!vi)
      return errResponse("not_found", "retype: unknown instruction");
    if (!vi->getType()->isIntegerTy())
      return errResponse("invalid", "retype handles integer types only");
    llvm::SMDiagnostic smd;
    llvm::Type *newTy = llvm::parseType(*ty, smd, *M);
    if (!newTy || !newTy->isIntegerTy())
      return errResponse("invalid", "retype: '" + ty->str() + "' is not an integer type");
    llvm::Type *oldTy = vi->getType();
    if (oldTy == newTy)
      return errResponse("invalid", "retype: the value already has that type");
    bool widening = newTy->getIntegerBitWidth() > oldTy->getIntegerBitWidth();

    // The definition keeps computing in the old type and is converted under
    // the old name; every use converts back. Whether the conversions lose
    // nothing is the claim the caller's alive2 check has to settle.
    llvm::SmallVector<llvm::Use *, 8> uses;
    for (llvm::Use &U : vi->uses())
      if (llvm::isa<llvm::Instruction>(U.getUser()))
        uses.push_back(&U);

    std::string name = vi->getName().str();
    vi->setName("");
    auto opcode = [&](bool grow) {
      if (grow)
        return ext == "sext" ? llvm::Instruction::SExt : llvm::Instruction::ZExt;
      return llvm::Instruction::Trunc;
    };
    auto *conv = llvm::CastInst::Create(opcode(widening), vi, newTy, name);
    // Phis come first in a block, so a phi's conversion goes after all of them.
    conv->insertInto(vi->getParent(), llvm::isa<llvm::PHINode>(vi)
                                          ? vi->getParent()->getFirstInsertionPt()
                                          : std::next(vi->getIterator()));
    for (llvm::Use *use : uses) {
      auto *back = llvm::CastInst::Create(opcode(!widening), conv, oldTy);
      auto at = beforeUse(*use);
      back->insertInto(at->getParent(), at);
      use->set(back);
    }
    return checkedResponse(*M);
  }

  if (*op == "dedup") {
    auto a = args.getString("a");
    auto b = args.getString("b");
    if (!a || !b)
      return missing("'a' and 'b'");
    llvm::Instruction *ai = refs.resolveInst(*a);
    llvm::Instruction *bi = refs.resolveInst(*b);
    if (!ai || !bi)
      return errResponse("not_found", "dedup: unknown instruction");
    if (ai == bi)
      return errResponse("invalid", "dedup: the two instructions are the same");
    if (ai->getType() != bi->getType())
      return errResponse("type_mismatch", "dedup: the instructions have different types");
    if (bi->isTerminator())
      return errResponse("invalid", "dedup: the terminator cannot be erased");
    if (!reachesEveryUse(ai, bi))
      return errResponse("dominance", "dedup: '" + refs.print(*ai) +
                                          "' does not reach every use of '" + refs.print(*bi) +
                                          "'");
    bi->replaceAllUsesWith(ai);
    bi->eraseFromParent();
    return checkedResponse(*M);
  }

  if (*op == "copy_block") {
    auto block = args.getString("block");
    auto preds = args.getArray("preds");
    if (!block || !preds || preds->empty())
      return missing("'block' and 'preds'");
    llvm::BasicBlock *B = blockNamed(*F, refs, *block);
    if (!B)
      return errResponse("not_found", "copy_block: unknown block '" + block->str() + "'");
    llvm::SmallPtrSet<llvm::BasicBlock *, 4> from;
    for (const llvm::json::Value &pred : *preds) {
      auto ref = pred.getAsString();
      llvm::BasicBlock *P = ref ? blockNamed(*F, refs, *ref) : nullptr;
      if (!P || !llvm::is_contained(llvm::predecessors(B), P))
        return errResponse("invalid", "copy_block: '" + (ref ? ref->str() : std::string("?")) +
                                          "' does not branch to the block");
      from.insert(P);
    }
    if (llvm::all_of(llvm::predecessors(B), [&](llvm::BasicBlock *P) { return from.contains(P); }))
      return errResponse("invalid", "copy_block: the copy would take every edge into the block");
    // A value used after the block would need a phi of its own.
    if (const llvm::Instruction *I = usedAfter(B))
      return errResponse("invalid", "copy_block: '" + refs.print(*I) + "' is used after the block");
    llvm::ValueToValueMapTy vmap;
    llvm::BasicBlock *copy = llvm::CloneBasicBlock(B, vmap, "", F);
    // A phi takes its values along the edges into the block, so they stay the block's.
    for (llvm::Instruction &I : *copy)
      if (!llvm::isa<llvm::PHINode>(I))
        llvm::RemapInstruction(&I, vmap, llvm::RF_IgnoreMissingLocals);
    for (llvm::BasicBlock *P : from)
      P->getTerminator()->replaceSuccessorWith(B, copy);
    // Each successor once: its phis hold an entry for each edge from the block, which
    // the copy repeats, read before the block's own phis drop theirs.
    llvm::SmallPtrSet<llvm::BasicBlock *, 4> after(llvm::succ_begin(copy), llvm::succ_end(copy));
    for (llvm::BasicBlock *S : after)
      for (llvm::PHINode &phi : S->phis())
        for (unsigned k = 0, n = phi.getNumIncomingValues(); k < n; ++k)
          if (phi.getIncomingBlock(k) == B) {
            llvm::Value *v = phi.getIncomingValue(k);
            llvm::Value *mapped = vmap.lookup(v);
            phi.addIncoming(mapped ? mapped : v, copy);
          }
    // Each phi of the block keeps the edges that still enter it, and its copy the others.
    auto entering = [&](llvm::PHINode &phi, bool copied) {
      phi.removeIncomingValueIf(
          [&](unsigned k) { return from.contains(phi.getIncomingBlock(k)) != copied; },
          /*DeletePHIIfEmpty=*/false);
    };
    for (llvm::PHINode &phi : B->phis())
      entering(phi, false);
    for (llvm::PHINode &phi : copy->phis())
      entering(phi, true);
    return checkedResponse(*M);
  }

  if (*op == "peel") {
    auto block = args.getString("block");
    if (!block)
      return missing("'block'");
    llvm::BasicBlock *H = blockNamed(*F, refs, *block);
    if (!H)
      return errResponse("not_found", "peel: unknown block '" + block->str() + "'");
    llvm::DominatorTree DT(*F);
    llvm::LoopInfo LI(DT);
    llvm::Loop *L = LI.getLoopFor(H);
    if (!L || L->getHeader() != H)
      return errResponse("invalid", "peel: '" + block->str() + "' is not the header of a loop");
    llvm::SmallVector<llvm::BasicBlock *, 8> blocks;
    for (llvm::BasicBlock &B : *F)
      if (L->contains(&B))
        blocks.push_back(&B);
    if (const llvm::Instruction *I = usedAfter(blocks))
      return errResponse("invalid", "peel: '" + refs.print(*I) + "' is used after the loop");

    // One iteration: a copy of each block of the loop, inner loops included,
    // whose edges between blocks of the loop stay in the copy.
    llvm::ValueToValueMapTy vmap;
    llvm::SmallVector<llvm::BasicBlock *, 8> copies;
    for (llvm::BasicBlock *B : blocks) {
      copies.push_back(llvm::CloneBasicBlock(B, vmap, "", F));
      vmap[B] = copies.back();
    }
    llvm::remapInstructionsInBlocks(copies, vmap);
    auto *first = llvm::cast<llvm::BasicBlock>(vmap[H]);
    auto mapped = [&](llvm::Value *v) {
      llvm::Value *copy = vmap.lookup(v);
      return copy ? copy : v;
    };
    // A phi takes along each edge from a copy what it takes along the edge copied.
    auto copyEdges = [&](llvm::PHINode &phi) {
      for (unsigned k = 0, n = phi.getNumIncomingValues(); k < n; ++k)
        if (L->contains(phi.getIncomingBlock(k)))
          phi.addIncoming(mapped(phi.getIncomingValue(k)),
                          llvm::cast<llvm::BasicBlock>(vmap[phi.getIncomingBlock(k)]));
    };
    llvm::SmallSetVector<llvm::BasicBlock *, 4> exits;
    for (llvm::BasicBlock *B : blocks)
      for (llvm::BasicBlock *S : llvm::successors(B))
        if (!L->contains(S))
          exits.insert(S);
    for (llvm::BasicBlock *E : exits)
      for (llvm::PHINode &phi : E->phis())
        copyEdges(phi);
    // The edges from before the loop enter the copy, whose back edges go to the
    // header: the header's phis trade the edges from before for those.
    llvm::SmallSetVector<llvm::BasicBlock *, 4> before;
    for (llvm::BasicBlock *P : llvm::predecessors(H))
      if (!L->contains(P))
        before.insert(P);
    auto entering = [&](llvm::PHINode &phi, bool copied) {
      phi.removeIncomingValueIf(
          [&](unsigned k) { return before.contains(phi.getIncomingBlock(k)) != copied; },
          /*DeletePHIIfEmpty=*/false);
    };
    for (llvm::PHINode &phi : H->phis()) {
      copyEdges(phi);
      entering(phi, false);
    }
    for (llvm::PHINode &phi : first->phis())
      entering(phi, true);
    for (llvm::BasicBlock *C : copies)
      C->getTerminator()->replaceSuccessorWith(first, H);
    for (llvm::BasicBlock *P : before)
      P->getTerminator()->replaceSuccessorWith(H, first);
    return checkedResponse(*M);
  }

  if (*op == "set_body") {
    auto body = args.getString("body");
    if (!body)
      return missing("'body'");
    // A body that opens with a module-level construct is the whole module
    // rather than the instructions after "entry:". An entry-block instruction
    // opens with '%' or an instruction opcode, so any other first token is
    // the lexer's own judgment that the text is not an instruction list;
    // "%name = type ..." is the one instruction-shaped module element, so its
    // second token is looked at too. Saying so before the parse turns a
    // confusing parser error into the contract itself.
    {
      TextLexer lexer(*body, M->getContext());
      auto moduleLike = [&](llvm::lltok::Kind kind) {
        switch (kind) {
        case llvm::lltok::GlobalVar:
        case llvm::lltok::GlobalID:
        case llvm::lltok::ComdatVar:
        case llvm::lltok::MetadataVar:
        case llvm::lltok::AttrGrpID:
        case llvm::lltok::hash:
        case llvm::lltok::kw_define:
        case llvm::lltok::kw_declare:
        case llvm::lltok::kw_source_filename:
        case llvm::lltok::kw_target:
        case llvm::lltok::kw_module:
        case llvm::lltok::kw_attributes:
          return true;
        default:
          return false;
        }
      };
      llvm::lltok::Kind first = lexer.next();
      if (moduleLike(first) ||
          (first == llvm::lltok::LocalVar && lexer.next() == llvm::lltok::equal &&
           lexer.next() == llvm::lltok::kw_type)) {
        return errResponse(
            "set_body_contract",
            "set_body takes the body after 'entry:', its later blocks included; the "
            "'define' header, braces, declarations, globals, types and attributes stay with "
            "the module");
      }
    }
    // Splice the new body into printed text and reparse the whole module, so
    // the result is an ordinary parse rather than surgery on a live module.
    // The search runs over our own output, where a definition opens with
    // "define" on one line and closes with "}" alone on another.
    std::string printed = printModule(*M);
    size_t bodyAt = std::string::npos, closeAt = std::string::npos;
    std::string opening = "@" + F->getName().str() + "(";
    for (size_t at = 0; at < printed.size();) {
      size_t eol = printed.find('\n', at);
      llvm::StringRef line(printed.data() + at,
                           (eol == std::string::npos ? printed.size() : eol) - at);
      if (bodyAt == std::string::npos) {
        if (line.starts_with("define ") && line.contains(opening))
          bodyAt = eol; // the body starts on the next line
      } else if (line == "}") {
        closeAt = at;
        break;
      }
      if (eol == std::string::npos)
        break;
      at = eol + 1;
    }
    if (bodyAt == std::string::npos || closeAt == std::string::npos)
      return errResponse("invalid", "set_body: cannot locate the function body");

    std::string newText =
        printed.substr(0, bodyAt + 1) + "entry:\n" + body->str() + "\n" + printed.substr(closeAt);
    std::string newErr;
    auto newMwc = parseModule(newText, &newErr);
    if (!newMwc)
      return errResponse("snippet_parse_error", newErr);
    llvm::Function *newF = singleFunction(*newMwc->mod);
    if (!newF)
      return errResponse("shape_error", "set_body: the new module must define exactly one "
                                        "function");
    return checkedResponse(*newMwc->mod);
  }

  if (*op == "drop_attrs") {
    dropCheckedAttrs(*F);
    return checkedResponse(*M);
  }

  if (*op == "flags") {
    auto v = args.getString("v");
    auto flags = args.getObject("flags");
    if (!v || !flags)
      return missing("'v' and 'flags'");
    llvm::Instruction *vi = refs.resolveInst(*v);
    if (!vi)
      return errResponse("not_found", "flags: unknown instruction");

    for (const auto &entry : *flags) {
      auto want = entry.second.getAsBoolean();
      if (!want)
        return errResponse("bad_request", "flags: '" + entry.first.str() + "' needs true or false");
      bool on = *want;
      llvm::StringRef kind = entry.first;

      // A flag an instruction cannot carry is refused rather than ignored, so
      // the agent never guesses what the IR will keep.
      if (kind == "nuw" || kind == "nsw") {
        auto *trunc = llvm::dyn_cast<llvm::TruncInst>(vi);
        auto *ovf = llvm::dyn_cast<llvm::OverflowingBinaryOperator>(vi);
        if (!ovf && !trunc)
          return errResponse("invalid",
                             "flags: '" + kind.str() + "' applies to add, sub, mul, shl and trunc");
        if (kind == "nuw")
          vi->setHasNoUnsignedWrap(on);
        else
          vi->setHasNoSignedWrap(on);
      } else if (kind == "exact") {
        auto *ex = llvm::dyn_cast<llvm::PossiblyExactOperator>(vi);
        if (!ex)
          return errResponse("invalid", "flags: 'exact' applies to the divisions and shifts");
        vi->setIsExact(on);
      } else if (kind == "nneg") {
        auto *nn = llvm::dyn_cast<llvm::PossiblyNonNegInst>(vi);
        if (!nn)
          return errResponse("invalid", "flags: 'nneg' applies to zext and uitofp");
        vi->setNonNeg(on);
      } else if (kind == "disjoint") {
        auto *dj = llvm::dyn_cast<llvm::PossiblyDisjointInst>(vi);
        if (!dj)
          return errResponse("invalid", "flags: 'disjoint' applies to or");
        dj->setIsDisjoint(on);
      } else {
        // The fast-math flags are one word on the instruction: the named flag
        // is set or cleared in a copy that goes back whole.
        auto *fp = llvm::dyn_cast<llvm::FPMathOperator>(vi);
        if (!fp)
          return errResponse("invalid",
                             "flags: '" + kind.str() + "' is not a flag of this instruction");
        llvm::FastMathFlags fmf = fp->getFastMathFlags();
        bool known = true;
        if (kind == "fast")
          fmf.setFast(on);
        else if (kind == "nnan")
          fmf.setNoNaNs(on);
        else if (kind == "ninf")
          fmf.setNoInfs(on);
        else if (kind == "nsz")
          fmf.setNoSignedZeros(on);
        else if (kind == "arcp")
          fmf.setAllowReciprocal(on);
        else if (kind == "contract")
          fmf.setAllowContract(on);
        else if (kind == "afn")
          fmf.setApproxFunc(on);
        else if (kind == "reassoc")
          fmf.setAllowReassoc(on);
        else
          known = false;
        if (!known)
          return errResponse("invalid",
                             "flags: '" + kind.str() + "' is not a flag of this instruction");
        vi->setFastMathFlags(fmf);
      }
    }
    return checkedResponse(*M);
  }

  return errResponse("bad_request", "unknown edit op '" + op->str() + "'");
}

} // namespace llops
