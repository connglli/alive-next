// `harness`: wrap a function in a main that llubi can run. The argument kinds
// and what comes back are in docs/llops.md.
//
// llubi runs `@main` and nothing else, its signature has to be
// `i32 @main(i32, ptr)`, and no command line sets an argument. So replaying a
// counterexample means building a module that calls the function under test
// with the values the counterexample gives, which is what this does.
//
// Everything the run should be judged on is loaded back under a name starting
// with `obs.`, because llubi's verbose trace prints an instruction with its
// result and that is the only channel wide enough: the exit code is the return
// value truncated to eight bits. The return value goes through memory for the
// same reason the final bytes do, so that every observation is one line of the
// shape `%obs.something = load ... -> value`.
#pragma once

#include "llvm/Support/JSON.h"

namespace llops {

llvm::json::Object harnessCmd(llvm::json::Object &args);

} // namespace llops
