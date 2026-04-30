# tv-next — alive-next compositional translation validator core (library).
#
# The library exposes diff / cut / verify / compose primitives consumed by
# the `alive-tv-next` tool (tools/alive-tv-next.cpp) and, eventually, by
# any further alive-next-family tools (test helpers, fuzzers, etc.).
#
# Convention follows alive2's other library directories (`ir/`, `smt/`,
# `llvm_util/`, etc.): a flat layout of `.h` / `.cpp` files, registered
# with the top-level CMake via `add_subdirectory(tv-next)`. The driver
# binary lives in `tools/` alongside `alive-tv.cpp`.
#
# This CMakeLists is invoked from the top-level `if (BUILD_LLVM_UTILS OR
# BUILD_TV)` block, so LLVM headers are already on the include path.
# Headers in this directory are referenced as `tv-next/foo.h` from any
# consumer (the project root is on the include path).

set(TV_NEXT_SRCS
  ir_load.cpp
  diff.cpp
  cut.cpp
  proposer.cpp
  verify.cpp
  compose.cpp
)

add_library(tv-next STATIC ${TV_NEXT_SRCS})
target_compile_options(tv-next PRIVATE -fexceptions)
