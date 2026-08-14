#include "edit.h"

#include "irutil.h"

#include "llvm/ADT/StringExtras.h"
#include "llvm/AsmParser/LLLexer.h"
#include "llvm/AsmParser/Parser.h"
#include "llvm/IR/Attributes.h"
#include "llvm/IR/ConstantRange.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Operator.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/Local.h"
#include <string>
#include <vector>

namespace llops {

namespace {

// ---------------------------------------------------------------------------
// Snippets
//
// `replace` and `insert` take instruction text. The text is parsed inside a
// throwaway function whose parameters stand for the values the snippet uses
// from the real function, so the snippet is type-checked by the same parser
// alive-tv uses. The parsed instructions are then cloned into the real
// function with those parameters remapped to the real values.
// ---------------------------------------------------------------------------

struct Snippet {
  std::vector<llvm::Instruction *> insts;
};

bool isNameChar(char c) { return llvm::isAlnum(c) || c == '_' || c == '.' || c == '$' || c == '-'; }

// One local value token of a snippet: where it sits in the text, what it
// says, and whether the line defines it rather than using it.
struct Token {
  size_t begin = 0, end = 0;
  std::string name;
  bool isDef = false;
};

// Scan snippet text for local value tokens. Comments and string literals are
// skipped, so a ';' comment or a '%' inside a string is never mistaken for a
// reference. A token is a definition when it opens its line and an '=' comes
// next, which is exactly how LLVM prints a result.
std::vector<Token> scanTokens(llvm::StringRef text) {
  std::vector<Token> tokens;
  size_t lineStart = 0;
  for (size_t i = 0; i < text.size();) {
    char c = text[i];
    if (c == '\n') {
      lineStart = ++i;
      continue;
    }
    if (c == ';') { // comment to end of line
      while (i < text.size() && text[i] != '\n')
        ++i;
      continue;
    }
    if (c == '"') { // string literal; LLVM escapes any inner quote as \22
      for (++i; i < text.size() && text[i] != '"'; ++i)
        ;
      if (i < text.size())
        ++i;
      continue;
    }
    if (c != '%') {
      ++i;
      continue;
    }
    Token tok;
    tok.begin = i;
    size_t j = i + 1;
    if (j < text.size() && text[j] == '"') {
      for (++j; j < text.size() && text[j] != '"'; ++j)
        ;
      if (j < text.size())
        ++j;
    } else {
      while (j < text.size() && isNameChar(text[j]))
        ++j;
    }
    tok.end = j;
    tok.name = text.substr(i + 1, j - i - 1).str();
    bool opensLine =
        text.substr(lineStart, i - lineStart).find_first_not_of(" \t") == llvm::StringRef::npos;
    size_t after = j;
    while (after < text.size() && (text[after] == ' ' || text[after] == '\t'))
      ++after;
    tok.isDef = opensLine && after < text.size() && text[after] == '=';
    if (!tok.name.empty())
      tokens.push_back(std::move(tok));
    i = j;
  }
  return tokens;
}

// A lexer over caller-provided text, run exactly as the assembly parser runs
// one. Its kind stream is the parser's own classification, so a diagnostic
// about what a body or a snippet says is the same judgment parsing it would
// make, and the buffer it reads is owned by its own SourceMgr.
struct TextLexer {
  llvm::SourceMgr sm;
  llvm::SMDiagnostic diag;
  llvm::LLLexer lexer;

  TextLexer(llvm::StringRef text, llvm::LLVMContext &ctx) : lexer(text, sm, diag, ctx) {
    sm.AddNewSourceBuffer(llvm::MemoryBuffer::getMemBuffer(text), llvm::SMLoc());
  }

  llvm::lltok::Kind next() { return lexer.Lex(); }
};

// Parse `text` against the values of F. `replacing`, when set, is the
// definition the caller is about to erase: the snippet may take its name back
// but may not use it, which would turn the replacement into a use of itself.
bool parseSnippet(llvm::Function &F, ValueRefs &refs, llvm::StringRef text, llvm::Value *replacing,
                  Snippet &out, llvm::json::Object &err) {
  // A snippet is instructions only: the block's own terminator stays, so a
  // snippet that carries one is a mistake before it is a parse. The terminator
  // keywords are reserved words, so one anywhere in the text is a terminator
  // instruction: a value name, comment or string cannot lex as one. Naming it
  // here beats the parser error it would otherwise produce, which reads as if
  // the whole function returned something else.
  {
    static constexpr llvm::lltok::Kind kTerminators[] = {
        llvm::lltok::kw_ret,        llvm::lltok::kw_br,          llvm::lltok::kw_switch,
        llvm::lltok::kw_indirectbr, llvm::lltok::kw_invoke,      llvm::lltok::kw_callbr,
        llvm::lltok::kw_resume,     llvm::lltok::kw_catchswitch, llvm::lltok::kw_catchret,
        llvm::lltok::kw_cleanupret, llvm::lltok::kw_unreachable,
    };
    TextLexer lexer(text, F.getContext());
    for (llvm::lltok::Kind kind = lexer.next(); kind != llvm::lltok::Eof; kind = lexer.next())
      if (llvm::is_contained(kTerminators, kind)) {
        err = errResponse("snippet_terminator",
                          "a snippet is instructions only: a terminator keyword would end the "
                          "block, whose own terminator stays in place");
        return false;
      }
  }

  std::vector<Token> tokens = scanTokens(text);

  std::vector<std::string> defs;
  for (const auto &tok : tokens)
    if (tok.isDef && !llvm::is_contained(defs, tok.name))
      defs.push_back(tok.name);

  // A snippet may not shadow a value that already exists: LLVM would rename
  // the new one behind the agent's back.
  for (const auto &name : defs) {
    llvm::Value *existing = refs.resolve(name);
    if (existing && existing != replacing) {
      err = errResponse("name_taken", "snippet defines '%" + name + "', which already exists");
      return false;
    }
  }

  // Rewrite every use of an outside value to a parameter of the scratch
  // function. Renaming sidesteps the numbering rules: an unnamed value such
  // as %3 cannot be a parameter name of an unrelated function.
  std::vector<llvm::Value *> actuals;
  std::vector<std::string> paramNames;
  std::string body;
  size_t copied = 0;
  for (const auto &tok : tokens) {
    if (tok.isDef || llvm::is_contained(defs, tok.name))
      continue;
    llvm::Value *v = refs.resolve(tok.name);
    if (!v) {
      // A named struct type wears the same '%' as a value, and the scratch
      // function has no way to declare it. set_body reparses the whole
      // module, types included, so that is the way through.
      if (llvm::StructType::getTypeByName(F.getContext(), tok.name)) {
        err = errResponse("named_type", "snippet names the type '%" + tok.name +
                                            "'; use set_body for instructions that need it");
        return false;
      }
      err =
          errResponse("undefined_value", "snippet uses '%" + tok.name + "', which is not in scope");
      return false;
    }
    if (v == replacing) {
      err = errResponse("invalid", "snippet uses '%" + tok.name + "', the value it replaces");
      return false;
    }
    auto known = llvm::find(actuals, v);
    std::string param;
    if (known == actuals.end()) {
      param = "llops.in." + std::to_string(actuals.size());
      actuals.push_back(v);
      paramNames.push_back(param);
    } else {
      param = paramNames[known - actuals.begin()];
    }
    body += text.substr(copied, tok.begin - copied);
    body += "%" + param;
    copied = tok.end;
  }
  body += text.substr(copied);

  std::string scratchText = "define void @llops.scratch(";
  {
    llvm::raw_string_ostream os(scratchText);
    for (size_t i = 0; i < actuals.size(); ++i) {
      if (i)
        os << ", ";
      actuals[i]->getType()->print(os);
      os << " %" << paramNames[i];
    }
    os << ") {\nentry:\n" << body << "\nret void\n}\n";
  }

  std::string parseErr;
  // Parse in the real module's context so the cloned instructions keep types
  // and constants that outlive the throwaway module.
  auto mwc = parseModule(scratchText, &parseErr, F.getContext());
  if (!mwc) {
    err = errResponse("snippet_parse_error", parseErr);
    return false;
  }
  llvm::Function *scratch = mwc->mod->getFunction("llops.scratch");
  llvm::BasicBlock *scratchBB = singleBlock(*scratch);
  if (!scratchBB) {
    err = errResponse("snippet_parse_error", "a snippet must be a straightline instruction list");
    return false;
  }

  llvm::ValueToValueMapTy vmap;
  for (size_t i = 0; i < actuals.size(); ++i)
    vmap[std::next(scratch->arg_begin(), i)] = actuals[i];
  // A snippet that calls something makes the parser invent a declaration in
  // the throwaway module. The clones have to point at the real module's
  // declaration instead, which is created when it is not there yet.
  llvm::Module &M = *F.getParent();
  for (llvm::GlobalValue &gv : mwc->mod->global_values()) {
    if (&gv == scratch)
      continue;
    if (auto *real = M.getNamedValue(gv.getName())) {
      vmap[&gv] = real;
      continue;
    }
    auto *fn = llvm::dyn_cast<llvm::Function>(&gv);
    if (!fn) {
      err = errResponse("undefined_value", "snippet names '@" + gv.getName().str() +
                                               "', which the module does not "
                                               "have");
      return false;
    }
    auto *real = llvm::Function::Create(fn->getFunctionType(), fn->getLinkage(), fn->getName(), &M);
    real->setAttributes(fn->getAttributes());
    vmap[&gv] = real;
  }

  for (auto &I : *scratchBB) {
    if (llvm::isa<llvm::ReturnInst>(&I))
      continue;
    auto *clone = I.clone();
    clone->setName(I.getName()); // the agent's own names survive the edit
    vmap[&I] = clone;
    out.insts.push_back(clone);
  }
  for (auto *clone : out.insts)
    llvm::RemapInstruction(clone, vmap,
                           llvm::RF_IgnoreMissingLocals | llvm::RF_ReuseAndMutateDistinctMDs);
  if (out.insts.empty())
    err = errResponse("empty_snippet", "the snippet defines no instructions");
  return !out.insts.empty();
}

// Collect an "insts" array into one text block.
bool joinInsts(const llvm::json::Array &insts, std::string &out, llvm::json::Object &err) {
  for (const auto &line : insts) {
    auto s = line.getAsString();
    if (!s) {
      err = errResponse("bad_request", "'insts' must be an array of strings");
      return false;
    }
    out += s->str();
    out += "\n";
  }
  return true;
}

// True when `earlier` comes before `later` in the block, or is `later`.
bool precedes(llvm::BasicBlock &BB, llvm::Instruction *earlier, llvm::Instruction *later) {
  for (auto &I : BB) {
    if (&I == earlier)
      return true;
    if (&I == later)
      return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

// Add one parameter attribute described by a JSON entry. Attributes are
// proposals: an attribute the program does not honour turns into UB, which
// is what the caller's alive2 check is there to catch.
bool addParamAttr(llvm::Argument &arg, llvm::StringRef kind, const llvm::json::Value &val,
                  llvm::json::Object &err) {
  llvm::LLVMContext &ctx = arg.getContext();
  auto simple = [&](llvm::Attribute::AttrKind k) {
    arg.addAttr(llvm::Attribute::get(ctx, k));
    return true;
  };
  if (kind == "noundef")
    return simple(llvm::Attribute::NoUndef);
  if (kind == "nonnull")
    return simple(llvm::Attribute::NonNull);
  if (kind == "noalias")
    return simple(llvm::Attribute::NoAlias);
  if (kind == "align") {
    auto bytes = val.getAsInteger();
    if (!bytes || *bytes <= 0 || !llvm::isPowerOf2_64((uint64_t)*bytes)) {
      err = errResponse("invalid", "align must be a positive power of two");
      return false;
    }
    arg.addAttr(llvm::Attribute::getWithAlignment(ctx, llvm::Align((uint64_t)*bytes)));
    return true;
  }
  if (kind == "dereferenceable") {
    auto bytes = val.getAsInteger();
    if (!bytes || *bytes <= 0) {
      err = errResponse("invalid", "dereferenceable must be a positive byte count");
      return false;
    }
    arg.addAttr(llvm::Attribute::getWithDereferenceableBytes(ctx, (uint64_t)*bytes));
    return true;
  }
  if (kind == "range") {
    auto *range = val.getAsObject();
    auto min = range ? range->getInteger("min") : std::nullopt;
    auto max = range ? range->getInteger("max") : std::nullopt;
    if (!min || !max) {
      err = errResponse("invalid", "range needs {\"min\": n, \"max\": m}");
      return false;
    }
    if (!arg.getType()->isIntegerTy()) {
      err = errResponse("invalid", "range applies to integer parameters only");
      return false;
    }
    unsigned bits = arg.getType()->getIntegerBitWidth();
    if (bits < 64 && (!llvm::isIntN(bits, *min) || !llvm::isIntN(bits, *max))) {
      err = errResponse("invalid", "range bounds do not fit the parameter type");
      return false;
    }
    // The range is the half-open interval [min, max), so the two bounds being
    // equal describes no value at all.
    if (*min == *max) {
      err = errResponse("invalid", "range must be a non-empty half-open interval");
      return false;
    }
    llvm::AttrBuilder B(ctx);
    B.addRangeAttr(llvm::ConstantRange(llvm::APInt(bits, (uint64_t)*min, true),
                                       llvm::APInt(bits, (uint64_t)*max, true)));
    arg.addAttrs(B);
    return true;
  }
  err = errResponse("invalid", "unknown attribute '" + kind.str() + "'");
  return false;
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
  llvm::BasicBlock *BB = shape.BB;
  ValueRefs refs(*F);

  auto missing = [&](llvm::StringRef what) {
    return errResponse("bad_request", op->str() + " needs " + what.str());
  };

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
    if (ai == BB->getTerminator() || bi == BB->getTerminator())
      return errResponse("invalid", "swap: the terminator cannot move");
    // Exchange the two positions: put the later one where the earlier sits,
    // then put the earlier one where the later sat.
    llvm::Instruction *first = precedes(*BB, ai, bi) ? ai : bi;
    llvm::Instruction *second = first == ai ? bi : ai;
    auto afterSecond = std::next(second->getIterator());
    BB->splice(first->getIterator(), BB, second->getIterator());
    BB->splice(afterSecond, BB, first->getIterator());
    return checkedResponse(*F, *M);
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
    if (vi == BB->getTerminator())
      return errResponse("invalid", "move: the terminator cannot move");
    if (wi == BB->getTerminator() && *where == "after")
      return errResponse("invalid", "move: nothing comes after the terminator");
    BB->splice(*where == "before" ? wi->getIterator() : std::next(wi->getIterator()), BB,
               vi->getIterator());
    return checkedResponse(*F, *M);
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
    if (auto *bi = llvm::dyn_cast<llvm::Instruction>(vb))
      for (llvm::User *u : va->users())
        if (auto *usi = llvm::dyn_cast<llvm::Instruction>(u))
          if (usi == bi || !precedes(*BB, bi, usi))
            return errResponse("dominance", "substitute: '" + refs.print(*vb) +
                                                "' does not reach every use of '" +
                                                refs.print(*va) + "'");
    va->replaceAllUsesWith(vb);
    return checkedResponse(*F, *M);
  }

  if (*op == "replace") {
    auto v = args.getString("v");
    auto insts = args.getArray("insts");
    if (!v || !insts)
      return missing("'v' and 'insts'");
    llvm::Instruction *oldDef = refs.resolveInst(*v);
    if (!oldDef)
      return errResponse("not_found", "replace: unknown instruction");
    if (oldDef == BB->getTerminator())
      return errResponse("invalid", "replace: the terminator cannot be replaced");
    std::string snippet;
    llvm::json::Object err;
    if (!joinInsts(*insts, snippet, err))
      return err;

    Snippet s;
    if (!parseSnippet(*F, refs, snippet, oldDef, s, err))
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
      inst->insertInto(BB, oldDef->getIterator());
    if (!oldDef->getType()->isVoidTy())
      oldDef->replaceAllUsesWith(last);
    oldDef->eraseFromParent();
    if (last->getName().empty())
      last->setName(oldName);
    return checkedResponse(*F, *M);
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
    if (wi == BB->getTerminator() && *where == "after")
      return errResponse("invalid", "insert: nothing comes after the terminator");
    std::string snippet;
    llvm::json::Object err;
    if (!joinInsts(*insts, snippet, err))
      return err;
    Snippet s;
    if (!parseSnippet(*F, refs, snippet, nullptr, s, err))
      return err;
    auto pos = *where == "before" ? wi->getIterator() : std::next(wi->getIterator());
    for (auto *inst : s.insts)
      inst->insertInto(BB, pos);
    return checkedResponse(*F, *M);
  }

  if (*op == "erase") {
    auto v = args.getString("v");
    if (!v)
      return missing("'v'");
    bool cascade = args.getBoolean("cascade").value_or(false);
    llvm::Instruction *vi = refs.resolveInst(*v);
    if (!vi)
      return errResponse("not_found", "erase: unknown instruction");
    if (vi == BB->getTerminator())
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
    return checkedResponse(*F, *M);
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
    return checkedResponse(*F, *M);
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
      return errResponse("invalid", "retype: v1 handles integer types only");
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
    conv->insertInto(BB, std::next(vi->getIterator()));
    for (llvm::Use *use : uses) {
      auto *user = llvm::cast<llvm::Instruction>(use->getUser());
      auto *back = llvm::CastInst::Create(opcode(!widening), conv, oldTy);
      back->insertInto(BB, user->getIterator());
      use->set(back);
    }
    return checkedResponse(*F, *M);
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
    if (bi == BB->getTerminator())
      return errResponse("invalid", "dedup: the terminator cannot be erased");
    for (llvm::User *u : bi->users())
      if (auto *usi = llvm::dyn_cast<llvm::Instruction>(u))
        if (!precedes(*BB, ai, usi))
          return errResponse("dominance", "dedup: '" + refs.print(*ai) +
                                              "' does not reach every use of '" + refs.print(*bi) +
                                              "'");
    bi->replaceAllUsesWith(ai);
    bi->eraseFromParent();
    return checkedResponse(*F, *M);
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
            "set_body takes the instructions after 'entry:', the final 'ret' included; the "
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
    return checkedResponse(*newF, *newMwc->mod);
  }

  if (*op == "attrs") {
    auto fnName = args.getString("fn");
    auto param = args.getInteger("param");
    auto attrs = args.getObject("attrs");
    if (!fnName || !param || !attrs)
      return missing("'fn', 'param' and 'attrs'");
    llvm::Function *G = M->getFunction(*fnName);
    if (!G)
      return errResponse("not_found", "attrs: no function named '" + fnName->str() + "'");
    if (*param < 0 || (uint64_t)*param >= G->arg_size())
      return errResponse("invalid", "attrs: parameter index out of range");
    llvm::Argument &arg = *std::next(G->arg_begin(), (unsigned)*param);
    for (const auto &entry : *attrs) {
      llvm::json::Object err;
      if (!addParamAttr(arg, entry.first, entry.second, err))
        return err;
    }
    return checkedResponse(*F, *M);
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
    return checkedResponse(*F, *M);
  }

  return errResponse("bad_request", "unknown edit op '" + op->str() + "'");
}

} // namespace llops
