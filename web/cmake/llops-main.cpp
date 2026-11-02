// Web entry point for llops: dispatch native commands and add combined-IR input.
// LLVM splits the input so declarations, globals and attributes retain meaning.
#include "llvm/AsmParser/Parser.h"
#include "llvm/IR/Module.h"
#include "llvm/IR/Verifier.h"
#include "llvm/Support/InitLLVM.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/SourceMgr.h"
#include "llvm/Support/raw_ostream.h"
#include "llvm/Transforms/Utils/Cloning.h"

int llopsMain(int argc, char **argv);

namespace {

int refuse(llvm::StringRef message) {
  llvm::outs() << llvm::formatv(
      "{0}\n", llvm::json::Value(llvm::json::Object{{"ok", false}, {"message", message}}));
  return 1;
}

std::string half(const llvm::Module &module, llvm::StringRef kept, llvm::StringRef removed,
                 llvm::StringRef entry) {
  auto clone = llvm::CloneModule(module);
  clone->getFunction(removed)->eraseFromParent();
  clone->getFunction(kept)->setName(entry);

  std::string text;
  llvm::raw_string_ostream stream(text);
  clone->print(stream, nullptr);
  return text;
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 2 || llvm::StringRef(argv[1]) != "split")
    return llopsMain(argc, argv);

  llvm::InitLLVM init(argc, argv);
  auto input = llvm::MemoryBuffer::getSTDIN();
  if (!input)
    return refuse("Cannot read the module");

  auto json = llvm::json::parse((*input)->getBuffer());
  if (!json)
    return refuse("Invalid JSON request");
  auto *object = json->getAsObject();
  auto text = object ? object->getString("module") : std::nullopt;
  if (!text)
    return refuse("Expected a module defining @src and @tgt");

  llvm::LLVMContext context;
  llvm::SMDiagnostic diagnostic;
  auto module = llvm::parseAssemblyString(*text, diagnostic, context);
  if (!module) {
    std::string message;
    llvm::raw_string_ostream stream(message);
    diagnostic.print("IR", stream, false);
    return refuse(message);
  }

  // Reject invalid IR before cloning; the searcher's inputs must be well formed.
  std::string invalid;
  llvm::raw_string_ostream validation(invalid);
  if (llvm::verifyModule(*module, &validation))
    return refuse(invalid);

  auto *src = module->getFunction("src");
  auto *tgt = module->getFunction("tgt");
  if (!src || !tgt || src->isDeclaration() || tgt->isDeclaration())
    return refuse("Define both @src and @tgt in one module");
  for (const auto &function : *module)
    if (!function.isDeclaration() && &function != src && &function != tgt)
      return refuse("Only @src and @tgt may have bodies; use declarations for other functions");

  // Each clone erases the other entry, so both must be free of all references.
  if (!src->use_empty() || !tgt->use_empty() || src->isUsedByMetadata() || tgt->isUsedByMetadata())
    return refuse("References to @src or @tgt are unsupported; provide independent functions");
  if (src->getFunctionType() != tgt->getFunctionType())
    return refuse("@src and @tgt must have the same function type");

  // Both modules need the same entry name without colliding with a shared global.
  std::string entry = "itv";
  while (module->getNamedValue(entry))
    entry += "_";

  llvm::json::Object result{{"ok", true},
                            {"src", half(*module, "src", "tgt", entry)},
                            {"tgt", half(*module, "tgt", "src", entry)}};
  llvm::outs() << llvm::formatv("{0}\n", llvm::json::Value(std::move(result)));
  return 0;
}
