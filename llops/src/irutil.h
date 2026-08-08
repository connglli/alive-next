// Shared IR plumbing: parsing, printing, canonicalization, value references
// and the straightline v1 well-formedness checks. Stateless helpers only;
// docs/implementation.md holds the tool contract.
#pragma once

#include "llvm/ADT/ArrayRef.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/ModuleSlotTracker.h"
#include "llvm/Support/JSON.h"
#include <memory>
#include <string>
#include <vector>

namespace llops {

// A structured diagnostic, surfaced to the agent as cheap feedback. The code
// is the stable part: agents and tests match on it, messages are free text.
struct Diag {
  enum class Severity { Error, Warning };
  Severity severity = Severity::Error;
  std::string code;
  std::string message;
};

// A parsed module plus the context owning its types and constants. The
// context is shared so that two modules parsed together can exchange values.
struct ModuleWithCtx {
  std::shared_ptr<llvm::LLVMContext> ctx;
  std::unique_ptr<llvm::Module> mod;
};

// Parse IR text. On failure returns nullptr and fills `err`.
std::unique_ptr<ModuleWithCtx> parseModule(llvm::StringRef text, std::string *err);

// Parse into a caller-provided context, so two modules can share types and
// constants. Needed by `inline`, which clones instructions across modules.
std::unique_ptr<ModuleWithCtx> parseModule(llvm::StringRef text, std::string *err,
                                           llvm::LLVMContext &sharedCtx);

// Print a module as IR text. The ModuleID and source_filename headers are
// dropped because they carry the input buffer name, which would make two
// equal programs differ in bytes.
std::string printModule(llvm::Module &M);

// Print a module with every local value renumbered: names are dropped so
// LLVM numbers values in definition order, and blocks are named by position.
// Turns "identical up to names" into "identical bytes". This is the only
// operation in llops that renames anything; every other subcommand preserves
// the names it is given.
std::string canonModule(llvm::Module &M);

// The v1 program shape is one defined function; returns it or nullptr.
llvm::Function *singleFunction(llvm::Module &M);

// The single basic block of a straightline function, or nullptr.
llvm::BasicBlock *singleBlock(llvm::Function &F);

// The v1 module invariants: exactly one defined function, no calls that v1
// cannot reason about, and a straightline body. An empty result means the
// module conforms.
std::vector<Diag> validateModule(llvm::Module &M);

// The v1 body invariants: one block, ending in `ret`, every use after its
// definition.
std::vector<Diag> checkFunction(llvm::Function &F);

// Everything else that makes IR ill formed, delegated to the LLVM verifier
// rather than restated here. Every edit ends with this check, so a broken
// edit is reported instead of handed back as text.
std::vector<Diag> checkModule(llvm::Module &M);

// Values are referenced by the token that names them in printed IR, so the
// agent can quote back what it reads: "%3" for a slot, "%x" for a name and
// "#7" for the instruction at index 7, which is the only form that reaches
// an instruction defining no value. docs/llops.md states the contract.
//
// A ValueRefs is a snapshot of one function: slot numbers come from the same
// tracker the printer uses, so resolving and printing cannot disagree.
// Rebuild it after mutating the function.
class ValueRefs {
public:
  explicit ValueRefs(llvm::Function &F);

  // The value a reference names, or nullptr when nothing matches.
  llvm::Value *resolve(llvm::StringRef ref);

  // Same, restricted to instructions of the body.
  llvm::Instruction *resolveInst(llvm::StringRef ref);

  // The reference that names V in printed IR, for example "%3" or "%x".
  std::string print(const llvm::Value &V);

private:
  llvm::Function &fn;
  llvm::ModuleSlotTracker mst;
};

// Render diagnostics into a response object under "diagnostics".
void addDiagnostics(llvm::json::Object &O, llvm::ArrayRef<Diag> diags);

// A failed response: { "ok": false, "error": { "code", "message" } }.
llvm::json::Object errResponse(llvm::StringRef code, llvm::StringRef message);

// A successful response carrying one module: { "ok": true, "module": ... }.
llvm::json::Object moduleResponse(llvm::Module &M);

} // namespace llops
