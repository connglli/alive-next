// llops: the native, stateless LLVM toolbox behind the agent's tools. One
// JSON request on stdin, one JSON response on stdout, nothing kept between
// invocations. See docs/implementation.md for the contract.
#include "analyze.h"
#include "assume.h"
#include "canon.h"
#include "edit.h"
#include "harness.h"
#include "irutil.h"
#include "outline.h"
#include "validate.h"

#include "llvm/Config/llvm-config.h"
#include "llvm/Support/InitLLVM.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/raw_ostream.h"

namespace {

const char *kUsage = "usage: llops <subcommand> < request.json > response.json\n"
                     "\n"
                     "subcommands:\n"
                     "  validate   check the straightline v1 invariants\n"
                     "  canon      renumber values canonically\n"
                     "  edit       apply one semantic edit op\n"
                     "  outline    move a suffix or a window into a function\n"
                     "  inline     substitute a callee back into its outer function\n"
                     "  analyze    known bits, ranges or pointer facts at a program point\n"
                     "  harness    wrap a function in a main that llubi can run\n"
                     "  assume     state a fact about a value before an instruction\n"
                     "  version    print the version\n"
                     "\n"
                     "Exit status is 0 when the response says ok, 1 when it does not, and\n"
                     "2 when the command line itself is wrong.\n";

// Emit the response and turn it into an exit status, so a caller can branch
// on the process result without parsing the body.
int respond(llvm::json::Object resp) {
  bool ok = resp.getBoolean("ok").value_or(false);
  llvm::outs() << llvm::formatv("{0}", llvm::json::Value(std::move(resp))) << "\n";
  return ok ? 0 : 1;
}

} // namespace

int main(int argc, char **argv) {
  llvm::InitLLVM X(argc, argv);

  if (argc != 2) {
    llvm::errs() << kUsage;
    return 2;
  }
  llvm::StringRef cmd = argv[1];
  if (cmd == "version") {
    llvm::outs() << "llops 0.1.0 (LLVM " << LLVM_VERSION_STRING << ")\n";
    return 0;
  }
  if (cmd == "help" || cmd == "--help" || cmd == "-h") {
    llvm::outs() << kUsage;
    return 0;
  }

  auto input = llvm::MemoryBuffer::getSTDIN();
  if (!input)
    return respond(llops::errResponse("bad_request", "cannot read the request from stdin"));
  auto parsed = llvm::json::parse((*input)->getBuffer());
  if (!parsed)
    return respond(llops::errResponse("bad_json", llvm::toString(parsed.takeError())));
  auto *args = parsed->getAsObject();
  if (!args)
    return respond(llops::errResponse("bad_request", "the request must be a JSON object"));

  if (cmd == "validate")
    return respond(llops::validateCmd(*args));
  if (cmd == "canon")
    return respond(llops::canonCmd(*args));
  if (cmd == "edit")
    return respond(llops::editCmd(*args));
  if (cmd == "outline")
    return respond(llops::outlineCmd(*args));
  if (cmd == "inline")
    return respond(llops::inlineCmd(*args));
  if (cmd == "analyze")
    return respond(llops::analyzeCmd(*args));
  if (cmd == "harness")
    return respond(llops::harnessCmd(*args));
  if (cmd == "assume")
    return respond(llops::assumeCmd(*args));

  llvm::errs() << "llops: unknown subcommand '" << cmd << "'\n" << kUsage;
  return 2;
}
