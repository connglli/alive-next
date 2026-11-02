#include "util/scoped_timer.h"
#include <cassert>
#include <chrono>
#include <climits>
#include <iostream>
#include <stdexcept>

namespace {

struct Handler : event_handler {
  unsigned fired = 0;
  bool throws = false;

  void operator()(event_handler_caller_t caller) override {
    assert(caller == TIMEOUT_EH_CALLER);
    ++fired;
    if (throws)
      throw std::runtime_error("timer callback");
  }
};

void pollUntil(Handler &handler) {
  auto end = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (!handler.fired && std::chrono::steady_clock::now() < end)
    scoped_timer::poll();
  assert(handler.fired == 1);
}

} // namespace

int main() {
  scoped_timer::initialize();

  Handler first, second, disabled;
  {
    scoped_timer zero(0, &disabled), infinite(UINT_MAX, &disabled);
    scoped_timer a(1, &first);
    scoped_timer b(3, &second);
    pollUntil(first);
    pollUntil(second);
    for (int i = 0; i < 4096; ++i)
      scoped_timer::poll();
    assert(first.fired == 1 && second.fired == 1 && disabled.fired == 0);
  }

  // Destroyed timers must be removed from the active polling set.
  Handler destroyed;
  { scoped_timer timer(1, &destroyed); }
  Handler after;
  {
    scoped_timer timer(2, &after);
    pollUntil(after);
    assert(destroyed.fired == 0);
  }

  // A throwing callback must not suppress later timers through the reentry guard.
  Handler throwing;
  throwing.throws = true;
  try {
    scoped_timer timer(1, &throwing);
    pollUntil(throwing);
    assert(false);
  } catch (const std::runtime_error &) {
    assert(throwing.fired == 1);
  }

  Handler recovered;
  {
    scoped_timer timer(1, &recovered);
    pollUntil(recovered);
  }

  scoped_timer::finalize();
  std::cout << "z3 timers passed\n";
}
