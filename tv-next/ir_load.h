// alive-tv-next: load a paired @src/@tgt slice from one or two LLVM IR files.
//
// Supports both alive-tv input forms:
//   - One file containing @src and @tgt functions (single-file form).
//   - Two files: file1 contains @src, file2 contains @tgt (paired form).
//
// Wraps llvm_util::openInputFile + llvm_util::findFunction; verifies the
// modules with llvm::verifyModule before returning. Diagnostics on errs().

#pragma once

#include "llvm/IR/Function.h"
#include "llvm/IR/LLVMContext.h"
#include "llvm/IR/Module.h"

#include <memory>
#include <optional>
#include <string>

namespace alive_tv_next {

// A loaded slice. `module1` always owns the IR backing `src_fn`; `module2`
// is non-null only in the paired-file form, in which case it owns `tgt_fn`.
// In single-file form, `module2` is null and `tgt_fn` lives in `module1`.
struct LoadedSlice {
  std::unique_ptr<llvm::Module> module1;
  std::unique_ptr<llvm::Module> module2;  // null = single-file form
  llvm::Function *src_fn = nullptr;
  llvm::Function *tgt_fn = nullptr;
};

// Load a paired slice. `file2` may be empty for the single-file form.
// `src_fn_name` / `tgt_fn_name` default to "src" / "tgt" at the call site.
//
// Returns std::nullopt and prints a diagnostic to errs() on parse,
// verifyModule, or function-lookup failure.
std::optional<LoadedSlice>
loadSlice(const std::string &file1,
          const std::string &file2,
          const std::string &src_fn_name,
          const std::string &tgt_fn_name,
          llvm::LLVMContext &ctx);

}  // namespace alive_tv_next
