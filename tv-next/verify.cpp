#include "tv-next/verify.h"

#include "llvm_util/llvm2alive.h"

#include "tools/transform.h"

#include "util/errors.h"

#include "llvm/Support/raw_ostream.h"

#include <sstream>

namespace alive_tv_next {

CutVerdict verifyCut(Cut &cut, llvm::TargetLibraryInfoWrapperPass &tli,
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

  // Check typability before running the prover. If type-check fails we
  // can't proceed.
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

}  // namespace alive_tv_next
