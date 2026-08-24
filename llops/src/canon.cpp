#include "canon.h"

#include "irutil.h"

namespace llops {

llvm::json::Object canonCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  if (!text)
    return errResponse("bad_request", "canon needs 'module'");

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);

  // The no-undef model leaves no room for an `undef` value anywhere in a
  // program, and canon is the gate text passes through to become a stored
  // program, so this is where the model is enforced. A refusal here is what
  // keeps every later question one the model covers.
  if (holdsUndef(*mwc->mod))
    return errResponse("undef",
                       "the module holds an undef value, which the no-undef model excludes");

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["module"] = canonModule(*mwc->mod);
  return resp;
}

} // namespace llops
