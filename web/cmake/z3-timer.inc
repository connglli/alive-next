// Z3 4.8.12's timers need a thread even in its SINGLE_THREAD build. In a
// browser worker, resource-limit polls deliver the same cancellation callback.
#include <algorithm>
#include <chrono>
#include <climits>
#include <vector>

struct scoped_timer::imp {
  using Clock = std::chrono::steady_clock;
  Clock::time_point deadline;
  event_handler *handler;
  bool fired = false;

  static std::vector<imp *> &active() {
    static std::vector<imp *> timers;
    return timers;
  }

  imp(unsigned ms, event_handler *eh)
      : deadline(Clock::now() + std::chrono::milliseconds(ms)), handler(eh) {
    active().push_back(this);
  }

  ~imp() {
    auto &timers = active();
    timers.erase(std::find(timers.begin(), timers.end(), this));
  }
};

scoped_timer::scoped_timer(unsigned ms, event_handler *eh)
    : m_imp(ms == 0 || ms == UINT_MAX ? nullptr : new imp(ms, eh)) {}

scoped_timer::~scoped_timer() { delete m_imp; }

void scoped_timer::initialize() {}
void scoped_timer::finalize() {}

void scoped_timer::poll() {
  static unsigned ticks = 0;
  static bool polling = false;

  // Amortize clock reads across resource checks and avoid callback reentrancy.
  if (polling || (++ticks & 1023) != 0)
    return;

  // A cancellation callback may throw; the next poll must still be enabled.
  struct Guard {
    bool &held;
    explicit Guard(bool &value) : held(value) { held = true; }
    ~Guard() { held = false; }
  } guard(polling);

  auto now = imp::Clock::now();
  for (auto *timer : imp::active()) {
    if (!timer->fired && now >= timer->deadline) {
      timer->fired = true;
      (*timer->handler)(TIMEOUT_EH_CALLER);
    }
  }
}
