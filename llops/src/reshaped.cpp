#include "reshaped.h"

#include "attrs.h"
#include "irutil.h"
#include "llvm/ADT/STLExtras.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/InlineAsm.h"
#include "llvm/IR/InstrTypes.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Metadata.h"
#include "llvm/IR/ModuleSlotTracker.h"
#include "llvm/IR/Operator.h"
#include "llvm/IR/TypeFinder.h"
#include "llvm/Support/raw_ostream.h"
#include <array>
#include <map>
#include <set>
#include <variant>

namespace llops {

namespace {

using Values = std::set<const llvm::Value *>;
using Block = llvm::BasicBlock;
using Predicate = llvm::CmpInst::Predicate;
// Why not, or nothing when nothing is wrong.
using Why = std::optional<std::string>;

// What a value of `after` holds, in terms of `before`: the values that hold
// the same, and the constants it equals.
struct Held {
  Values same;
  std::set<std::string> equals;
  bool operator==(const Held &o) const { return same == o.same && equals == o.equals; }
};

// What holds at one point of both runs.
struct Relation {
  std::map<const llvm::Value *, Held> of;
  // The values of `before` that hold each constant, by its text.
  std::map<std::string, Values> holding;
  bool operator==(const Relation &o) const { return of == o.of && holding == o.holding; }
};

using Moves = std::vector<std::pair<const llvm::PHINode *, const llvm::Value *>>;

// What one side runs from where a block is entered: the phis it sets and the
// instructions it applies, in order, and the terminator it stops at.
struct Segment {
  std::vector<std::variant<Moves, llvm::Instruction *>> events;
  llvm::Instruction *end = nullptr;
  Block *last = nullptr;
};

// A pair of entering edges: after's from and to, then before's.
using Key = std::array<const Block *, 4>;

// The comparisons of `after` and `before`, one the inverse of the other, that
// the branches ending both segments take.
using Flip = std::pair<const llvm::Value *, const llvm::Value *>;

bool local(const llvm::Value *v) { return llvm::isa<llvm::Instruction, llvm::Argument>(v); }

// What two sets share.
template <typename T> std::set<T> meet(const std::set<T> &x, const std::set<T> &y) {
  std::set<T> out;
  for (const T &v : x)
    if (y.count(v))
      out.insert(v);
  return out;
}

// What holds on both of two paths.
Relation meet(const Relation &x, const Relation &y) {
  Relation out;
  for (const auto &[a, h] : x.of)
    if (auto it = y.of.find(a); it != y.of.end())
      out.of[a] = {meet(h.same, it->second.same), meet(h.equals, it->second.equals)};
  for (const auto &[c, s] : x.holding)
    if (auto it = y.holding.find(c); it != y.holding.end())
      out.holding[c] = meet(s, it->second);
  return out;
}

// The two modules are read in contexts of their own, so that each keeps the
// names of its struct types, and what they share is text: a constant prints
// with its type, and a named struct prints by its name, whose body both
// modules must give it.
std::string textOf(const llvm::Value &v, const llvm::Module *M) {
  std::string text;
  llvm::raw_string_ostream os(text);
  v.printAsOperand(os, /*PrintType=*/true, M);
  return text;
}

std::string textOf(const llvm::Type &T) {
  std::string text;
  llvm::raw_string_ostream os(text);
  T.print(os);
  return text;
}

// The body of a named struct: its elements, each printed as above.
std::string bodyOf(const llvm::StructType &T) {
  if (T.isOpaque())
    return "opaque";
  std::string text = T.isPacked() ? "<{" : "{";
  for (const llvm::Type *E : T.elements())
    text += " " + textOf(*E) + ",";
  return text + (T.isPacked() ? " }>" : " }");
}

// The bodies of the named structs `M` uses anywhere, by name, or nothing when
// one has no name to tell it by.
std::optional<std::map<std::string, std::string>> structsOf(const llvm::Module &M) {
  llvm::TypeFinder found;
  found.run(M, /*onlyNamed=*/false);
  std::map<std::string, std::string> bodies;
  for (const llvm::StructType *T : found) {
    if (T->isLiteral())
      continue;
    if (!T->hasName())
      return std::nullopt;
    bodies[T->getName().str()] = bodyOf(*T);
  }
  return bodies;
}

// Whether metadata `x` of one module says what `y` of the other does: strings
// and constants that print the same, or uniqued tuples of such. A distinct
// node is an identity of its own module and matches nothing in the other; nor
// does any other node, such as debug info, which this does not take apart.
bool sameMetadata(const llvm::Metadata *x, const llvm::Module *mx, const llvm::Metadata *y,
                  const llvm::Module *my) {
  if (!x || !y)
    return x == y;
  if (auto *s = llvm::dyn_cast<llvm::MDString>(x)) {
    auto *t = llvm::dyn_cast<llvm::MDString>(y);
    return t && s->getString() == t->getString();
  }
  if (auto *c = llvm::dyn_cast<llvm::ConstantAsMetadata>(x)) {
    auto *d = llvm::dyn_cast<llvm::ConstantAsMetadata>(y);
    return d && textOf(*c->getValue(), mx) == textOf(*d->getValue(), my);
  }
  auto *n = llvm::dyn_cast<llvm::MDTuple>(x);
  auto *m = llvm::dyn_cast<llvm::MDTuple>(y);
  if (!n || !m || n->isDistinct() || m->isDistinct())
    return false;
  if (n->getNumOperands() != m->getNumOperands())
    return false;
  for (unsigned k = 0; k < n->getNumOperands(); ++k)
    if (!sameMetadata(n->getOperand(k), mx, m->getOperand(k), my))
      return false;
  return true;
}

// Metadata an instruction or a function carries, by the name of its kind,
// which unlike its number is the same in both contexts.
using Attached = std::vector<std::pair<std::string, const llvm::MDNode *>>;

// The metadata `O` carries that alive2 reads. alive2 gives debug info, loop
// properties, branch weights, unpredictable, nosanitize and irce.loop.clone no
// meaning, so neither does a run.
template <typename T> Attached readOf(const T &O) {
  static const llvm::StringRef ignored[] = {
      "dbg", "llvm.loop", "prof", "unpredictable", "nosanitize", "irce.loop.clone",
  };
  llvm::SmallVector<std::pair<unsigned, llvm::MDNode *>> mds;
  O.getAllMetadata(mds);
  llvm::SmallVector<llvm::StringRef> names;
  O.getContext().getMDKindNames(names);
  Attached read;
  for (const auto &[kind, node] : mds)
    if (!llvm::is_contained(ignored, names[kind]))
      read.emplace_back(names[kind].str(), node);
  llvm::sort(read);
  return read;
}

bool sameAttached(const Attached &x, const llvm::Module *mx, const Attached &y,
                  const llvm::Module *my) {
  if (x.size() != y.size())
    return false;
  for (size_t k = 0; k < x.size(); ++k)
    if (x[k].first != y[k].first || !sameMetadata(x[k].second, mx, y[k].second, my))
      return false;
  return true;
}

// The segment run on entering `to` from `from`, nothing for the entry block.
Why segmentOf(Block *from, Block *to, Segment &seg) {
  llvm::SmallPtrSet<Block *, 8> seen;
  for (;;) {
    if (!seen.insert(to).second)
      return std::string("unconditional branches loop without a condition");
    Moves moves;
    for (const llvm::PHINode &phi : to->phis()) {
      // A move copies a value, so a phi that could make it poison is not followed.
      if (!readOf(phi).empty() ||
          (llvm::isa<llvm::FPMathOperator>(phi) && phi.getFastMathFlags().any()))
        return std::string("a phi carries flags or metadata");
      int k = from ? phi.getBasicBlockIndex(from) : -1;
      if (k < 0)
        return std::string("a phi has no value for the edge it is entered by");
      moves.emplace_back(&phi, phi.getIncomingValue(k));
    }
    if (!moves.empty())
      seg.events.push_back(std::move(moves));
    for (llvm::Instruction &I : *to)
      if (!llvm::isa<llvm::PHINode>(I) && !I.isTerminator())
        seg.events.push_back(&I);
    llvm::Instruction *end = to->getTerminator();
    if (!readOf(*end).empty())
      return std::string("a terminator carries metadata alive2 reads");
    auto *br = llvm::dyn_cast<llvm::BranchInst>(end);
    if (!br || br->isConditional()) {
      seg.end = end;
      seg.last = to;
      return std::nullopt;
    }
    from = to;
    to = br->getSuccessor(0);
  }
}

// An instruction on one line.
std::string lineOf(const llvm::Instruction &I) {
  std::string text;
  llvm::raw_string_ostream os(text);
  I.print(os);
  return llvm::StringRef(text).trim().str();
}

// Both runs, walked together.
class Walk {
public:
  Walk(llvm::Function &a, llvm::Function &b)
      : after(a), before(b), slotsA(a.getParent()), slotsB(b.getParent()) {}

  // Why some run of `after` is not a run of `before`, or nothing.
  Why run();

private:
  llvm::Function &after;
  llvm::Function &before;
  // How the modules of `after` and `before` number their values, for printing.
  llvm::ModuleSlotTracker slotsA;
  llvm::ModuleSlotTracker slotsB;
  std::map<const llvm::Instruction *, std::string> shapes;

  std::string shapeOf(llvm::Instruction &I, std::optional<Predicate> as = {});
  Held heldBy(const Relation &r, const llvm::Value *a) const;
  bool same(const Relation &r, const llvm::Value *a, const llvm::Value *b) const;
  void moveAfter(Relation &r, const Moves &moves) const;
  void moveBefore(Relation &r, const Moves &moves) const;
  Why match(Relation &r, llvm::Instruction &x, llvm::Instruction &y, bool &inverse);
  Why pair(Relation &r, const Segment &a, const Segment &b, Flip &flip);
  Why ends(const Relation &r, const Segment &a, const Segment &b, const Flip &flip,
           std::vector<std::pair<Block *, Block *>> &next) const;
};

// The instruction as it prints without its result, its metadata or the values
// it uses: the operation itself, with its flags, types and attributes. `as`
// gives a comparison another predicate.
std::string Walk::shapeOf(llvm::Instruction &I, std::optional<Predicate> as) {
  if (!as)
    if (auto it = shapes.find(&I); it != shapes.end())
      return it->second;
  llvm::Instruction *copy = I.clone();
  copy->insertBefore(I.getIterator());
  for (llvm::Use &U : copy->operands())
    if (llvm::isa<llvm::Instruction, llvm::Argument, llvm::Constant>(U.get()) &&
        !U->getType()->isTokenTy())
      U.set(llvm::PoisonValue::get(U->getType()));
  llvm::SmallVector<std::pair<unsigned, llvm::MDNode *>> mds;
  copy->getAllMetadata(mds);
  for (const auto &[kind, node] : mds)
    copy->setMetadata(kind, nullptr);
  if (as)
    llvm::cast<llvm::CmpInst>(copy)->setPredicate(*as);
  std::string text;
  llvm::raw_string_ostream os(text);
  copy->print(os, I.getFunction() == &after ? slotsA : slotsB);
  copy->eraseFromParent();
  std::string shape = llvm::StringRef(text).trim().str();
  if (!I.getType()->isVoidTy())
    shape = shape.substr(shape.find(" = ") + 3);
  if (!as)
    shapes[&I] = shape;
  return shape;
}

// What `after` operand `a` holds. A constant is held by every value of
// `before` that holds it, so that a path relating them through the constant
// and a path relating them directly agree where they meet.
Held Walk::heldBy(const Relation &r, const llvm::Value *a) const {
  if (local(a)) {
    auto it = r.of.find(a);
    return it == r.of.end() ? Held{} : it->second;
  }
  Held h;
  std::string c = textOf(*a, after.getParent());
  if (auto it = r.holding.find(c); it != r.holding.end())
    h.same = it->second;
  h.equals.insert(c);
  return h;
}

// Whether `after` operand `a` and `before` operand `b` hold the same value.
bool Walk::same(const Relation &r, const llvm::Value *a, const llvm::Value *b) const {
  const llvm::Module *ma = after.getParent(), *mb = before.getParent();
  // Metadata compares by what it says, and inline asm by its text.
  if (auto *x = llvm::dyn_cast<llvm::MetadataAsValue>(a)) {
    auto *y = llvm::dyn_cast<llvm::MetadataAsValue>(b);
    return y && sameMetadata(x->getMetadata(), ma, y->getMetadata(), mb);
  }
  if (llvm::isa<llvm::InlineAsm>(a))
    return llvm::isa<llvm::InlineAsm>(b) && textOf(*a, ma) == textOf(*b, mb);
  if (!local(a) && !llvm::isa<llvm::Constant>(a))
    return false;
  Held h = heldBy(r, a);
  if (local(b))
    return h.same.count(b) > 0;
  return llvm::isa<llvm::Constant>(b) && h.equals.count(textOf(*b, mb)) > 0;
}

// `before` value `v` takes a new value: nothing still holds the old one.
void forget(Relation &r, const llvm::Value *v) {
  for (auto &[a, h] : r.of)
    h.same.erase(v);
  for (auto &[c, s] : r.holding)
    s.erase(v);
}

// Phis of `after` take their values all at once.
void Walk::moveAfter(Relation &r, const Moves &moves) const {
  Relation old = r;
  for (const auto &[phi, v] : moves)
    r.of[phi] = heldBy(old, v);
}

// Phis of `before` take their values all at once: each holds what its value held.
void Walk::moveBefore(Relation &r, const Moves &moves) const {
  Relation old = r;
  for (const auto &[phi, v] : moves)
    forget(r, phi);
  for (const auto &[phi, v] : moves) {
    if (!local(v)) {
      std::string c = textOf(*v, before.getParent());
      r.holding[c].insert(phi);
      for (const auto &[a, h] : old.of)
        if (h.equals.count(c))
          r.of[a].same.insert(phi);
      continue;
    }
    for (const auto &[a, h] : old.of)
      if (h.same.count(v))
        r.of[a].same.insert(phi);
    for (const auto &[c, s] : old.holding)
      if (s.count(v))
        r.holding[c].insert(phi);
  }
}

// Whether `after` instruction `x` copies `before` instruction `y`, and if it
// does, relate their values. An integer comparison with the inverse predicate
// passes as `inverse`, and holds no value of `before`.
Why Walk::match(Relation &r, llvm::Instruction &x, llvm::Instruction &y, bool &inverse) {
  const llvm::Module *ma = after.getParent(), *mb = before.getParent();
  if (shapeOf(x) != shapeOf(y)) {
    auto *cx = llvm::dyn_cast<llvm::ICmpInst>(&x);
    auto *cy = llvm::dyn_cast<llvm::ICmpInst>(&y);
    inverse = cx && cy && cx->getPredicate() == cy->getInversePredicate() &&
              shapeOf(x, cy->getPredicate()) == shapeOf(y);
    if (!inverse)
      return "'" + lineOf(x) + "' is no copy of '" + lineOf(y) + "'";
  }
  if (x.getNumOperands() != y.getNumOperands())
    return "'" + lineOf(x) + "' is no copy of '" + lineOf(y) + "'";
  if (!sameAttached(readOf(x), ma, readOf(y), mb))
    return "'" + lineOf(x) + "' carries other metadata than '" + lineOf(y) + "'";
  for (unsigned k = 0; k < x.getNumOperands(); ++k) {
    if (same(r, x.getOperand(k), y.getOperand(k)))
      continue;
    std::string which = "operand " + std::to_string(k) + " of '" + lineOf(x) + "'";
    return which + " holds another value than in '" + lineOf(y) + "'";
  }
  forget(r, &y);
  r.of.erase(&x);
  if (!inverse && !x.getType()->isVoidTy())
    r.of[&x].same.insert(&y);
  return std::nullopt;
}

// Run both segments' instructions in step, each side's phis where they fall.
// An inverse comparison is followed only into the branch that ends `after`'s
// segment, its single use, which is where `ends` swaps the successors.
Why Walk::pair(Relation &r, const Segment &a, const Segment &b, Flip &flip) {
  size_t i = 0, j = 0;
  for (;;) {
    for (; i < a.events.size() && std::holds_alternative<Moves>(a.events[i]); ++i)
      moveAfter(r, std::get<Moves>(a.events[i]));
    for (; j < b.events.size() && std::holds_alternative<Moves>(b.events[j]); ++j)
      moveBefore(r, std::get<Moves>(b.events[j]));
    if (i == a.events.size() && j == b.events.size())
      break;
    if (i == a.events.size() || j == b.events.size())
      return std::string("one side runs more instructions than the other before a branch");
    auto *x = std::get<llvm::Instruction *>(a.events[i++]);
    auto *y = std::get<llvm::Instruction *>(b.events[j++]);
    bool inverse = false;
    if (auto why = match(r, *x, *y, inverse))
      return why;
    if (!inverse)
      continue;
    if (!x->hasOneUse() || x->user_back() != a.end)
      return "'" + lineOf(*x) + "' is used other than by the branch that ends its segment";
    flip = {x, y};
  }
  return std::nullopt;
}

// Whether both segments end the same way, and the pairs of blocks they go on to.
Why Walk::ends(const Relation &r, const Segment &a, const Segment &b, const Flip &flip,
               std::vector<std::pair<Block *, Block *>> &next) const {
  llvm::Instruction *x = a.end, *y = b.end;
  std::string differ = "'" + lineOf(*x) + "' ends no copy of '" + lineOf(*y) + "'";
  if (auto *rx = llvm::dyn_cast<llvm::ReturnInst>(x)) {
    auto *ry = llvm::dyn_cast<llvm::ReturnInst>(y);
    if (!ry)
      return differ;
    llvm::Value *vx = rx->getReturnValue(), *vy = ry->getReturnValue();
    if (!vx != !vy || (vx && !same(r, vx, vy)))
      return differ;
    return std::nullopt;
  }
  if (llvm::isa<llvm::UnreachableInst>(x))
    return llvm::isa<llvm::UnreachableInst>(y) ? std::nullopt : std::optional(differ);
  if (auto *bx = llvm::dyn_cast<llvm::BranchInst>(x)) {
    auto *by = llvm::dyn_cast<llvm::BranchInst>(y);
    if (!by)
      return differ;
    bool straight = same(r, bx->getCondition(), by->getCondition());
    if (!straight && flip != Flip{bx->getCondition(), by->getCondition()})
      return differ;
    next.emplace_back(bx->getSuccessor(0), by->getSuccessor(straight ? 0 : 1));
    next.emplace_back(bx->getSuccessor(1), by->getSuccessor(straight ? 1 : 0));
    return std::nullopt;
  }
  if (auto *sx = llvm::dyn_cast<llvm::SwitchInst>(x)) {
    auto *sy = llvm::dyn_cast<llvm::SwitchInst>(y);
    if (!sy || sx->getNumCases() != sy->getNumCases() ||
        !same(r, sx->getCondition(), sy->getCondition()))
      return differ;
    next.emplace_back(sx->getDefaultDest(), sy->getDefaultDest());
    for (auto c : sx->cases()) {
      std::string value = textOf(*c.getCaseValue(), after.getParent());
      auto it = llvm::find_if(sy->cases(), [&](auto d) {
        return textOf(*d.getCaseValue(), before.getParent()) == value;
      });
      if (it == sy->case_end())
        return differ;
      next.emplace_back(c.getCaseSuccessor(), it->getCaseSuccessor());
    }
    return std::nullopt;
  }
  return "reshaped does not follow '" + lineOf(*x) + "'";
}

// The walk visits each pair of entering edges again whenever what holds there
// shrinks, and stops once nothing does; this many visits means it did not.
constexpr unsigned kVisits = 1u << 20;

Why Walk::run() {
  Relation start;
  for (unsigned k = 0; k < after.arg_size(); ++k)
    start.of[after.getArg(k)].same.insert(before.getArg(k));
  Key first{nullptr, &after.getEntryBlock(), nullptr, &before.getEntryBlock()};
  std::map<Key, Relation> at{{first, start}};
  std::vector<Key> work{first};
  for (unsigned visits = 0; !work.empty(); ++visits) {
    if (visits == kVisits)
      return std::string("the walk does not settle");
    Key key = work.back();
    work.pop_back();
    Relation r = at[key];
    Segment a, b;
    auto *fromA = const_cast<Block *>(key[0]);
    auto *fromB = const_cast<Block *>(key[2]);
    if (auto why = segmentOf(fromA, const_cast<Block *>(key[1]), a))
      return "after: " + *why;
    if (auto why = segmentOf(fromB, const_cast<Block *>(key[3]), b))
      return "before: " + *why;
    Flip flip{nullptr, nullptr};
    if (auto why = pair(r, a, b, flip))
      return why;
    std::vector<std::pair<Block *, Block *>> next;
    if (auto why = ends(r, a, b, flip, next))
      return why;
    for (const auto &[toA, toB] : next) {
      Key k{a.last, toA, b.last, toB};
      auto it = at.find(k);
      if (it == at.end()) {
        at.emplace(k, r);
        work.push_back(k);
        continue;
      }
      Relation both = meet(it->second, r);
      if (both == it->second)
        continue;
      it->second = std::move(both);
      work.push_back(k);
    }
  }
  return std::nullopt;
}

// What dropping a body takes along and a declaration does not print: the
// personality, prefix and prologue data.
std::string extrasOf(const llvm::Function &F) {
  const llvm::Module *M = F.getParent();
  std::string text;
  if (F.hasPersonalityFn())
    text += "personality " + textOf(*F.getPersonalityFn(), M) + "\n";
  if (F.hasPrefixData())
    text += "prefix " + textOf(*F.getPrefixData(), M) + "\n";
  if (F.hasPrologueData())
    text += "prologue " + textOf(*F.getPrologueData(), M) + "\n";
  return text;
}

// Why the two modules differ other than in the function's body, or nothing.
Why restDiffers(llvm::Function &after, llvm::Function &before) {
  const llvm::Module *ma = after.getParent(), *mb = before.getParent();
  bool extras = extrasOf(after) == extrasOf(before);
  if (!extras || !sameAttached(readOf(after), ma, readOf(before), mb))
    return std::string("the functions differ in what goes with their bodies");
  // Dropping a body makes the function external, which would hide a change of linkage.
  for (llvm::Function *F : {&after, &before}) {
    auto linkage = F->getLinkage();
    F->deleteBody();
    F->setLinkage(linkage);
  }
  if (printModule(*after.getParent()) == printModule(*before.getParent()))
    return std::nullopt;
  return std::string("the modules differ other than in the function's body");
}

} // namespace

llvm::json::Object reshapedCmd(llvm::json::Object &args) {
  auto beforeText = args.getString("before");
  auto afterText = args.getString("after");
  if (!beforeText || !afterText)
    return errResponse("bad_request", "reshaped needs 'before' and 'after'");
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
    return errResponse("shape_error", "reshaped needs one defined function in each module");
  // The attributes alive2 ignores do not count.
  dropIgnoredAttrs(*beforeMwc->mod);
  dropIgnoredAttrs(*afterMwc->mod);
  // The walk takes each use to be dominated by its definition, as the verifier checks.
  for (auto *mwc : {beforeMwc.get(), afterMwc.get()})
    if (auto diags = checkModule(*mwc->mod); !diags.empty())
      return errResponse(diags.front().code, diags.front().message);
  // Each use of undef may take another value, so two copies of one need not agree.
  if (holdsUndef(*beforeMwc->mod) || holdsUndef(*afterMwc->mod))
    return errResponse("undef", "reshaped does not compare programs that hold undef");

  // Blocks are named by position, so one name could take two blocks' addresses.
  auto taken = [](llvm::Function &F) {
    return llvm::any_of(F, [](Block &B) { return B.hasAddressTaken(); });
  };
  auto structsA = structsOf(*afterMwc->mod), structsB = structsOf(*beforeMwc->mod);
  Why why;
  if (after->getName() != before->getName() ||
      textOf(*after->getFunctionType()) != textOf(*before->getFunctionType()))
    why = "the modules define different functions";
  else if (!structsA || !structsB || *structsA != *structsB)
    why = "the modules give their struct types other bodies, or one no name";
  else if (taken(*after) || taken(*before))
    why = "a block's address is taken";
  else
    why = Walk(*after, *before).run();
  if (!why)
    why = restDiffers(*after, *before);

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["reshaped"] = !why;
  if (why)
    resp["why"] = *why;
  return resp;
}

} // namespace llops
