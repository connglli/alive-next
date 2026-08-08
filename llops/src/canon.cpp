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

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["module"] = canonModule(*mwc->mod);
  return resp;
}

} // namespace llops
