#include "snippet.h"

#include "llvm/ADT/STLExtras.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/IR/DerivedTypes.h"
#include "llvm/IR/Instructions.h"
#include "llvm/Support/raw_ostream.h"
#include <climits>
#include <string>
#include <vector>

namespace llops {

namespace {

bool isNameChar(char c) { return llvm::isAlnum(c) || c == '_' || c == '.' || c == '$' || c == '-'; }

// One value token of a snippet: where it sits in the text, what it says,
// whether the line defines it rather than using it, and for `!N` the N.
struct Token {
  size_t begin = 0, end = 0;
  std::string name;
  bool isDef = false;
  int arg = -1;
};

// Scan snippet text for `%` value tokens and `!N`. Comments and string literals are
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
    if (c == '!' && i + 1 < text.size() && llvm::isDigit(text[i + 1])) {
      Token tok;
      tok.begin = i;
      size_t j = i + 1;
      while (j < text.size() && llvm::isDigit(text[j]))
        ++j;
      tok.end = j;
      tok.name = text.substr(i, j - i).str();
      if (text.substr(i + 1, j - i - 1).getAsInteger(10, tok.arg))
        tok.arg = INT32_MAX;
      tokens.push_back(std::move(tok));
      i = j;
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

} // namespace

bool parseSnippet(llvm::Function &F, ValueRefs &refs, llvm::StringRef text, llvm::Value *replacing,
                  const SnippetScope &scope, Snippet &out, llvm::json::Object &err) {
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
    llvm::Value *existing = scope.newNames ? refs.resolve(name) : nullptr;
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
    if (tok.arg < 0 && !scope.names) {
      err = errResponse("invalid", "'%" + tok.name + "' names a value, but here only " +
                                       "arguments may be named, as !0, !1, ...");
      return false;
    }
    if (tok.arg >= 0 && !scope.args) {
      err = errResponse("invalid",
                        "'" + tok.name + "' names an argument of a call, and there is none here");
      return false;
    }
    if (tok.arg >= 0 && (size_t)tok.arg >= scope.args->size()) {
      err = errResponse("not_found", "'" + tok.name + "' is past the last argument");
      return false;
    }
    llvm::Value *v = tok.arg >= 0 ? (*scope.args)[tok.arg] : refs.resolve(tok.name);
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

} // namespace llops
