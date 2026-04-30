#include "tv-next/verify.h"

#include "tv-next/proposer.h"

#include "llvm_util/llvm2alive.h"

#include "tools/transform.h"

#include "util/errors.h"

#include "llvm/Support/FileSystem.h"
#include "llvm/Support/raw_ostream.h"

#include <sstream>

namespace alive_tv_next {

namespace {

void dumpCut(const Cut &cut, const std::string &dump_dir) {
  if (dump_dir.empty())
    return;
  std::error_code ec;
  std::string path = dump_dir + "/";
  for (char c : cut.name)
    path += (std::isalnum((unsigned char)c) || c == '.' || c == '_' || c == '-')
                ? c
                : '_';
  path += ".srctgt.ll";
  llvm::raw_fd_ostream os(path, ec);
  if (!ec)
    cut.module->print(os, /*AAW=*/nullptr);
  else
    llvm::errs() << "alive-tv-next: dump-cuts: could not open " << path
                 << ": " << ec.message() << "\n";
}

// Run alive2 on a Cut once. No proposer logic. Used both for the initial
// verification and for verifying a proposer's modified cut / assume-check.
CutVerdict runOnce(Cut &cut, llvm::TargetLibraryInfoWrapperPass &tli,
                   smt::smt_initializer &smt_init) {
  CutVerdict v;
  v.name = cut.name;

  auto fn_src = llvm_util::llvm2alive(*cut.src_fn, tli.getTLI(*cut.src_fn),
                                       /*IsSrc=*/true);
  if (!fn_src) {
    v.status = CutVerdict::Status::Error;
    v.error_message = "could not translate src to alive2 IR";
    return v;
  }
  auto fn_tgt = llvm_util::llvm2alive(*cut.tgt_fn, tli.getTLI(*cut.tgt_fn),
                                       /*IsSrc=*/false, fn_src->getGlobalVars());
  if (!fn_tgt) {
    v.status = CutVerdict::Status::Error;
    v.error_message = "could not translate tgt to alive2 IR";
    return v;
  }

  tools::Transform t;
  t.name = cut.name;
  t.src = std::move(*fn_src);
  t.tgt = std::move(*fn_tgt);

  // Fast path: alive2's own syntactic-equivalence check on the lifted form.
  // For Phase 1 cuts this is unlikely to fire (we only build cuts at diff
  // positions), but harmless.
  {
    std::stringstream ss1, ss2;
    t.src.print(ss1);
    t.tgt.print(ss2);
    if (std::move(ss1).str() == std::move(ss2).str()) {
      v.status = CutVerdict::Status::SyntacticallyEqual;
      v.passed = true;
      return v;
    }
  }

  smt_init.reset();
  t.preprocess();
  tools::TransformVerify verifier(t, /*check_each_var=*/false);

  {
    auto types = verifier.getTypings();
    if (!types) {
      v.status = CutVerdict::Status::TypeCheckerFailed;
      v.error_message = "alive2 type-checker rejected the cut";
      return v;
    }
  }

  util::Errors errs = verifier.verify();
  if (errs) {
    if (errs.isUnsound()) {
      v.status = CutVerdict::Status::Unsound;
    } else {
      v.status = CutVerdict::Status::FailedToProve;
    }
    std::stringstream ss;
    ss << errs;
    v.error_message = std::move(ss).str();
    v.passed = false;
    return v;
  }

  v.status = CutVerdict::Status::Correct;
  v.passed = true;
  return v;
}

}  // namespace

CutVerdict verifyCut(Cut &cut, llvm::TargetLibraryInfoWrapperPass &tli,
                     smt::smt_initializer &smt_init,
                     llvm::Function *parent_src,
                     llvm::Module *parent_module,
                     const std::string &dump_dir) {
  CutVerdict v = runOnce(cut, tli, smt_init);

  if (v.passed)
    return v;
  if (v.status != CutVerdict::Status::Unsound &&
      v.status != CutVerdict::Status::FailedToProve)
    return v;
  if (!parent_src || !parent_module)
    return v;

  // Try the hand-coded proposers.
  auto proposed = proposeAssume(cut, *parent_src, *parent_module,
                                cut.module->getContext());
  if (!proposed)
    return v;

  dumpCut(proposed->assume_check, dump_dir);
  dumpCut(proposed->modified_cut, dump_dir);

  // Standalone soundness gate: the precondition must hold unconditionally
  // in the parent's input space.
  CutVerdict check_v = runOnce(proposed->assume_check, tli, smt_init);
  if (!check_v.passed) {
    v.error_message += "\n  proposer " + proposed->proposer_name +
                       " fired but assume-check failed: " +
                       check_v.error_message;
    return v;
  }

  // Re-verify the cut with `llvm.assume` injected.
  CutVerdict mod_v = runOnce(proposed->modified_cut, tli, smt_init);
  if (mod_v.passed) {
    mod_v.name = cut.name;
    mod_v.proposer_name = proposed->proposer_name;
    return mod_v;
  }

  v.error_message += "\n  proposer " + proposed->proposer_name +
                     " fired and assume-check passed, but modified cut " +
                     "still does not verify: " + mod_v.error_message;
  return v;
}

}  // namespace alive_tv_next
