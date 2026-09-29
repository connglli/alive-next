// Snippets: instruction text written by a caller, parsed against a function.
//
// `edit replace` and `edit insert` take instruction text, and so do the
// predicates `assume` puts in. The text is parsed inside a throwaway function
// whose parameters stand for the values the snippet uses from the real
// function, so the snippet is type-checked by the same parser alive-tv uses.
// The parsed instructions are then cloned with those parameters replaced by
// the real values. docs/llops.md says what each command accepts.
#pragma once

#include "irutil.h"

#include "llvm/AsmParser/LLLexer.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include <vector>

namespace llops {

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

// Collect an "insts" array into one text block.
bool joinInsts(const llvm::json::Array &insts, std::string &out, llvm::json::Object &err);

// The parsed instructions, cloned for the real function but not yet placed.
struct Snippet {
  std::vector<llvm::Instruction *> insts;
};

// What a snippet may name besides the values it defines.
struct SnippetScope {
  // Whether `%x` may name a value of the function.
  bool names = true;
  // Whether a name the snippet defines has to be new; if not, LLVM renames it.
  bool newNames = true;
  // The arguments `!N` names, N counting from 0; without them `!N` is refused.
  const std::vector<llvm::Value *> *args = nullptr;
};

// Parse `text` against the values of F. `replacing`, when set, is the
// definition the caller is about to erase: the snippet may take its name back
// but may not use it, which would turn the replacement into a use of itself.
bool parseSnippet(llvm::Function &F, ValueRefs &refs, llvm::StringRef text, llvm::Value *replacing,
                  const SnippetScope &scope, Snippet &out, llvm::json::Object &err);

} // namespace llops
