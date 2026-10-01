#include "number.h"

#include "irutil.h"

namespace llops {

llvm::json::Object numberCmd(llvm::json::Object &args) {
  CmdShape shape;
  llvm::json::Object err;
  if (!parseCmdShape(args, "number", shape, err))
    return err;

  llvm::json::Object resp;
  resp["ok"] = true;
  resp["module"] = printNumbered(*shape.M, *shape.refs);
  return resp;
}

} // namespace llops
