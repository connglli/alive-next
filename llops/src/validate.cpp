#include "validate.h"

#include "irutil.h"

namespace llops {

llvm::json::Object validateCmd(llvm::json::Object &args) {
  auto text = args.getString("module");
  if (!text)
    return errResponse("bad_request", "validate needs 'module'");

  std::string parseErr;
  auto mwc = parseModule(*text, &parseErr);
  if (!mwc)
    return errResponse("parse_error", parseErr);

  auto diags = validateModule(*mwc->mod);
  llvm::json::Object resp;
  resp["ok"] = true;
  resp["conforms"] = diags.empty();
  addDiagnostics(resp, diags);
  return resp;
}

} // namespace llops
