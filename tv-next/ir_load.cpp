#include "tv-next/ir_load.h"

#include "llvm_util/utils.h"

#include "llvm/IR/Verifier.h"
#include "llvm/Support/raw_ostream.h"

namespace alive_tv_next {

std::optional<LoadedSlice>
loadSlice(const std::string &file1, const std::string &file2,
          const std::string &src_fn_name, const std::string &tgt_fn_name,
          llvm::LLVMContext &ctx) {
  LoadedSlice slice;

  slice.module1 = llvm_util::openInputFile(ctx, file1);
  if (!slice.module1) {
    llvm::errs() << "alive-tv-next: could not read IR from '" << file1 << "'\n";
    return std::nullopt;
  }
  if (llvm::verifyModule(*slice.module1, &llvm::errs())) {
    llvm::errs() << "alive-tv-next: '" << file1 << "' failed llvm::verifyModule\n";
    return std::nullopt;
  }

  if (!file2.empty()) {
    slice.module2 = llvm_util::openInputFile(ctx, file2);
    if (!slice.module2) {
      llvm::errs() << "alive-tv-next: could not read IR from '" << file2
                   << "'\n";
      return std::nullopt;
    }
    if (llvm::verifyModule(*slice.module2, &llvm::errs())) {
      llvm::errs() << "alive-tv-next: '" << file2
                   << "' failed llvm::verifyModule\n";
      return std::nullopt;
    }
    slice.src_fn = llvm_util::findFunction(*slice.module1, src_fn_name);
    slice.tgt_fn = llvm_util::findFunction(*slice.module2, tgt_fn_name);
  } else {
    slice.src_fn = llvm_util::findFunction(*slice.module1, src_fn_name);
    slice.tgt_fn = llvm_util::findFunction(*slice.module1, tgt_fn_name);
  }

  if (!slice.src_fn) {
    llvm::errs() << "alive-tv-next: could not find @" << src_fn_name
                 << " in input\n";
    return std::nullopt;
  }
  if (!slice.tgt_fn) {
    llvm::errs() << "alive-tv-next: could not find @" << tgt_fn_name
                 << " in input\n";
    return std::nullopt;
  }
  if (slice.src_fn->getFunctionType() != slice.tgt_fn->getFunctionType()) {
    llvm::errs() << "alive-tv-next: @" << src_fn_name << " and @" << tgt_fn_name
                 << " have different signatures\n";
    return std::nullopt;
  }

  return slice;
}

}  // namespace alive_tv_next
