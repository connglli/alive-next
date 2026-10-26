// Shared IR plumbing: parsing, printing, canonicalization, value references
// and the program shape checks.
#pragma once

#include "llvm/ADT/ArrayRef.h"
#include "llvm/ADT/DenseMap.h"
#include "llvm/ADT/SmallPtrSet.h"
#include "llvm/IR/AssemblyAnnotationWriter.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/Instructions.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/ModuleSlotTracker.h"
#include "llvm/IR/ValueHandle.h"
#include "llvm/Support/JSON.h"
#include "llvm/Transforms/Utils/ValueMapper.h"
#include <memory>
#include <optional>
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

// The named struct types a module parsed into a context that already held one
// of the same name had to take a fresh name for, each mapped back to the
// context's own where their bodies agree. Code cloned through LLVM's value
// mapper with it uses the context's types, as the module's text did.
class RenamedTypes : public llvm::ValueMapTypeRemapper {
public:
  llvm::Type *remapType(llvm::Type *T) override;
  // Map each type the slot mapping names to the context's type of that name.
  void collect(const llvm::StringMap<llvm::Type *> &slots, llvm::LLVMContext &ctx);
  // `attrs` with each type it names remapped.
  llvm::AttributeList remap(llvm::AttributeList attrs, llvm::LLVMContext &ctx);
  // `text` with each renamed type spelled as the type it maps to.
  std::string respell(llvm::StringRef text) const;

private:
  llvm::DenseMap<llvm::Type *, llvm::Type *> named, built;
};

// A parsed module plus the context owning its types and constants. The
// context is shared so that two modules parsed together can exchange values.
struct ModuleWithCtx {
  std::shared_ptr<llvm::LLVMContext> ctx;
  std::unique_ptr<llvm::Module> mod;
  RenamedTypes renamed;
};

// Parse IR text. On failure returns nullptr and fills `err`.
std::unique_ptr<ModuleWithCtx> parseModule(llvm::StringRef text, std::string *err);

// Parse into a caller-provided context, so two modules can share types and
// constants; `renamed` maps each struct type LLVM renamed back to the
// context's. Needed by `inline`, which clones instructions across modules.
std::unique_ptr<ModuleWithCtx> parseModule(llvm::StringRef text, std::string *err,
                                           llvm::LLVMContext &sharedCtx);

// Print a module as IR text. The ModuleID and source_filename headers are
// dropped because they carry the input buffer name, which would make two
// equal programs differ in bytes. An annotator adds comments to the text.
std::string printModule(llvm::Module &M, llvm::AssemblyAnnotationWriter *annotator = nullptr);

// Print a module with every local value renumbered: names are dropped so
// LLVM numbers values in definition order, and blocks are named by position.
// Turns "identical up to names" into "identical bytes". This is the only
// operation in llops that renames anything; every other subcommand preserves
// the names it is given.
std::string canonModule(llvm::Module &M);

// The one function a program defines, or nullptr.
llvm::Function *singleFunction(llvm::Module &M);

// The single basic block of a straightline function, or nullptr.
llvm::BasicBlock *singleBlock(llvm::Function &F);

// The module invariants: exactly one defined function whose body has the
// shape below. An empty result means the module conforms.
std::vector<Diag> validateModule(llvm::Module &M);

// The body invariants: no call to anything but a declared function, every block
// ending in ret, br, switch or unreachable.
std::vector<Diag> checkFunction(llvm::Function &F);

// The first departure from the shape, if any.
std::optional<Diag> departure(llvm::Module &M);

// Everything else that makes IR ill formed, delegated to the LLVM verifier
// rather than restated here. Every edit ends with this check, so a broken
// edit is reported instead of handed back as text.
std::vector<Diag> checkModule(llvm::Module &M);

// Whether any value in the module is `undef`. Poison is a value of its own
// and passes, and so does metadata, since neither defines runtime state;
// everything that does, global initializers included, is searched through
// constants wherever a constant is accepted.
bool holdsUndef(const llvm::Module &M);

// Whether the body holds a loop, which alive-tv answers only as far as it unrolls.
bool holdsLoop(const llvm::Function &F);

// The first use of a pointer from `v` as more than the address of a load or a
// store, following GEPs, phis and selects, or nothing when there is none.
const llvm::User *escapingUse(const llvm::Value &v);

// Values are referenced by the token that names them in printed IR, so the
// agent can quote back what it reads: "%3" for a slot, "%x" for a name and
// "#7" for the instruction at index 7, which is the only form that reaches
// an instruction defining no value.
//
// A ValueRefs is a snapshot of one function's slots and instruction order:
// slot numbers come from the same tracker the printer uses, so resolving and
// printing cannot disagree. Rebuild it after mutating the function.
class ValueRefs {
public:
  explicit ValueRefs(llvm::Function &F);

  // The value a reference names, or nullptr when nothing matches.
  llvm::Value *resolve(llvm::StringRef ref);

  // Same, restricted to instructions of the body.
  llvm::Instruction *resolveInst(llvm::StringRef ref);

  // The reference that names V in printed IR, for example "%3" or "%x".
  std::string print(const llvm::Value &V);

  // The N in `#N` that names I: its index in the body as given, or nothing
  // for an instruction the body did not have.
  std::optional<unsigned> indexOf(const llvm::Instruction &I) const;

private:
  llvm::Function &fn;
  llvm::ModuleSlotTracker mst;
  std::vector<llvm::WeakVH> body;
};

// Print a module with each instruction of its function marked `; #N`, the
// reference that names it, at the column LLVM writes its own comments.
std::string printNumbered(llvm::Module &M, const ValueRefs &refs);

// Whether a call is as outline and detach make it, with nothing on it.
bool plainCall(const llvm::CallInst &call);

// Whether a type contains a pointer, including inside a vector or an aggregate.
bool holdsPointer(const llvm::Type *T);

// Why a callee, run in a frame of its own, could act differently than its code
// did in place in `outer`, or nothing. A window's frame ends before the rest of
// the body runs, so in one an alloca counts too.
std::optional<Diag> frameDependence(const llvm::Function &callee, const llvm::Function &outer,
                                    bool window);

// Put a callee's blocks but `skip` back at a call used only by the ret after it.
bool putBackRest(llvm::CallInst &call, llvm::Function &callee, llvm::Function &F,
                 llvm::ValueToValueMapTy &vmap,
                 const llvm::SmallPtrSetImpl<llvm::Instruction *> *skip = nullptr,
                 RenamedTypes *renamed = nullptr);

// Whether a slot is a one-value entry-block alloca only simple loads and stores of it use.
bool privateSlot(const llvm::AllocaInst &slot);

// The private slot `v` is, which a cut passes by what it holds, or nullptr.
llvm::AllocaInst *heldSlot(llvm::Value &v);

// The type a cut passes `v` as: what it holds when it is a private slot.
llvm::Type *passedType(llvm::Value &v);

// The ascending positions a request's `slots` names among `count` parameters, or nothing.
std::optional<std::vector<unsigned>> slotParams(const llvm::json::Object &args, unsigned count);

// The loads right before a call of private slots at `slots`: passed, or unused for poison.
std::optional<std::vector<llvm::LoadInst *>> slotLoads(llvm::CallInst &call,
                                                       llvm::ArrayRef<unsigned> slots);

// The stores that open a callee by copying its `slots` parameters into private slots.
std::optional<std::vector<llvm::StoreInst *>> slotCopies(llvm::Function &callee,
                                                         llvm::ArrayRef<unsigned> slots);

// Whether some path from `from` uses a read of `slot` before it stores into it.
bool readFirst(llvm::Value &slot, llvm::BasicBlock::iterator from);

// Whether every path from a copying store stores into its slot again before a used load.
bool storedBeforeRead(llvm::StoreInst &copying);

// Whether each copy a call passes poison for is stored into again before it is read.
bool deadSlotsUnread(llvm::CallInst &call, llvm::ArrayRef<unsigned> slots,
                     llvm::ArrayRef<llvm::StoreInst *> stores);

// Each copy mapped back to its slot and skipped with its store, unless the two differ.
bool slotsBack(llvm::ArrayRef<llvm::LoadInst *> loads, llvm::ArrayRef<llvm::StoreInst *> stores,
               llvm::ValueToValueMapTy &vmap, llvm::SmallPtrSetImpl<llvm::Instruction *> &skip);

// Render diagnostics into a response object under "diagnostics".
void addDiagnostics(llvm::json::Object &O, llvm::ArrayRef<Diag> diags);

// A failed response: { "ok": false, "error": { "code", "message" } }.
llvm::json::Object errResponse(llvm::StringRef code, llvm::StringRef message);

// A successful response carrying one module: { "ok": true, "module": ... }.
llvm::json::Object moduleResponse(llvm::Module &M);

// The response of an edit that must come out well formed: the shape check,
// loops allowed, then the LLVM verifier, and only then the module. Every
// mutating subcommand ends here, so a broken edit is reported rather than
// handed back as text.
llvm::json::Object checkedResponse(llvm::Module &M);

// The shape that every mutating subcommand needs: one module, one function,
// and the value references into it. The context that owns the types and
// constants has to outlive the pointers that use them, so it rides along.
struct CmdShape {
  std::unique_ptr<ModuleWithCtx> mwc;
  llvm::Module *M = nullptr;
  llvm::Function *F = nullptr;
  std::unique_ptr<ValueRefs> refs;
};

// Parse the "module" key of a JSON request into that shape. `cmd` names the
// subcommand for error messages ("edit", "opt", …). Returns true on success;
// on failure fills `err` and leaves `out` in a moved-from state.
bool parseCmdShape(llvm::json::Object &args, llvm::StringRef cmd, CmdShape &out,
                   llvm::json::Object &err);

// The instructions of a window, as a set: what is inside decides everything
// else, since a value is live in when the window uses it from outside and
// live out when something outside uses it from within.
llvm::SmallPtrSet<llvm::Instruction *, 16> setOf(llvm::ArrayRef<llvm::Instruction *> window);

// The values a window uses from outside it, in definition order: instructions
// in the order they are printed first, then arguments. The order is what makes
// the signature reproducible from the program alone.
std::vector<llvm::Value *> liveInto(llvm::Function &F,
                                    const llvm::SmallPtrSetImpl<llvm::Instruction *> &inside);

// The instructions from `cut` to `to`, or nothing when `to` does not come at
// or after `from`.
std::vector<llvm::Instruction *> windowOf(llvm::BasicBlock &BB, llvm::Instruction *from,
                                          llvm::Instruction *to);

// The instructions from `first` to `last`, or an error when they are not a
// window: both must be in one block, `first` must come first, and the range
// must hold no phi and no terminator. `hint` ends the error about the
// terminator.
std::vector<llvm::Instruction *> windowBetween(llvm::Instruction *first, llvm::Instruction *last,
                                               llvm::StringRef from, llvm::StringRef to,
                                               llvm::StringRef hint, llvm::json::Object &err);

// The window values that something outside it uses, in the order the rest of
// the body first uses them, which two versions differing only inside the
// window share.
std::vector<llvm::Instruction *>
liveOutOf(llvm::Function &F, llvm::ArrayRef<llvm::Instruction *> window,
          const llvm::SmallPtrSetImpl<llvm::Instruction *> &inside);

// One entry of a tgt signature: the tgt value `value_map` names for the
// entry's src value, with the type the entry gives it. Returns nullptr and
// fills `err` when there is no such value.
llvm::Value *mappedParam(const llvm::json::Value &entry, const llvm::json::Object &valueMap,
                         llvm::Function &F, ValueRefs &refs, llvm::json::Object &err);

// Map every symbol of `from` but `skip` onto the symbol of the same name in
// `into`, declaring a function `into` lacks. A global variable `into` lacks
// is an error when something uses it.
bool adoptSymbols(llvm::Module &from, llvm::Module &into, const llvm::GlobalValue *skip,
                  llvm::ValueToValueMapTy &vmap, RenamedTypes &renamed, llvm::json::Object &err);

// Whether a cut's halves agree on each shared symbol but `outerFn`, `calleeFn` and `hypothesis`.
bool sharedSymbolsAgree(llvm::Module &outerM, llvm::Function &outerFn, llvm::Module &calleeM,
                        llvm::Function &calleeFn, llvm::StringRef hypothesis,
                        const RenamedTypes &renamed, llvm::json::Object &err);

} // namespace llops
