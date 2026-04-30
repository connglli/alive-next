#include "tv-next/compose.h"

#include <sstream>

namespace alive_tv_next {

ComposeResult composeCuts(std::vector<CutVerdict> per_cut,
                          size_t identical_positions) {
  ComposeResult r;
  r.identical_positions = identical_positions;

  bool all_passed = true;
  std::stringstream err_summary;
  for (const CutVerdict &v : per_cut) {
    if (!v.passed) {
      all_passed = false;
      err_summary << "  " << v.name << ": ";
      switch (v.status) {
        case CutVerdict::Status::Unsound:
          err_summary << "UNSOUND";
          break;
        case CutVerdict::Status::FailedToProve:
          err_summary << "failed-to-prove";
          break;
        case CutVerdict::Status::TypeCheckerFailed:
          err_summary << "type-checker-failed";
          break;
        case CutVerdict::Status::Error:
          err_summary << "error";
          break;
        default:
          err_summary << "unexpected status";
          break;
      }
      if (!v.error_message.empty())
        err_summary << " — " << v.error_message;
      err_summary << "\n";
    }
  }

  r.passed = all_passed;
  r.per_cut = std::move(per_cut);
  if (!all_passed)
    r.error_message = std::move(err_summary).str();
  return r;
}

}  // namespace alive_tv_next
