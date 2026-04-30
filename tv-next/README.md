# tv-next

Alive-next's compositional translation validator — **library**, parallel to alive2's `ir/`, `smt/`, `llvm_util/`, etc. Holds the diff / cut / verify / compose primitives consumed by the `alive-tv-next` driver (whose `main()` lives in `tools/alive-tv-next.cpp`, parallel to `tools/alive-tv.cpp`).

**Status:** M1.2/M1.3 — diff + single-instr cut + per-cut alive2 + compose are implemented. M1.4/M1.5 (Example 1 + Example 1' verify end-to-end) require the LLVM-trunk-against alive2 build to be ready.

See [`../PLAN.md`](../PLAN.md) for the staged plan and [`../IDEA.md`](../IDEA.md) for the design rationale.

## Layout

Flat, matching alive2's per-library-directory style:

```
tv-next/
  CMakeLists.txt    # builds static library `tv-next`; registered via
                    #   add_subdirectory(tv-next) in the top-level CMakeLists.
  ir_load.{h,cpp}   # parse .ll → llvm::Module + @src/@tgt llvm::Functions
  diff.{h,cpp}      # per-line structural diff over single-BB equal-length functions
  cut.{h,cpp}       # single-instr cut builder (lift to small @src/@tgt pair)
  verify.{h,cpp}    # per-cut alive2 dispatch via TransformVerify::verify
  compose.{h,cpp}   # aggregate per-cut verdicts into slice-level verdict
  README.md         # this file
```

The driver / `main()` lives at [`../tools/alive-tv-next.cpp`](../tools/alive-tv-next.cpp), one level up. That file is registered as the executable target `alive-tv-next` in the top-level `CMakeLists.txt`, linked against this library plus alive2's `ALIVE_LIBS_LLVM`, Z3, hiredis, and the LLVM libs.

Header includes follow alive2's convention: `#include "tv-next/ir_load.h"` from any consumer (project root is on the include path).

## Building

Built as part of the standard alive2 build, gated on `BUILD_LLVM_UTILS` (or `BUILD_TV`). The library `tv-next` and the executable `alive-tv-next` are both registered automatically:

```bash
cd alive-next
mkdir -p build && cd build
cmake -GNinja -DCMAKE_PREFIX_PATH=~/llvm/build \
              -DBUILD_TV=1 -DCMAKE_BUILD_TYPE=Release ..
ninja alive-tv-next
./alive-tv-next --help
```

## Running

```bash
./alive-tv-next pre.ll post.ll
./alive-tv-next combined.srctgt.ll
./alive-tv-next combined.srctgt.ll --model gpt-4o      # later phases (LLM)
./alive-tv-next combined.srctgt.ll --verbose           # per-cut verdicts
```

Input is a raw slice. Assumes (when needed for Phase 3+ rewrites) are derived internally — `alive-tv-next` walks the slice, the hand-coded proposer (or LLM, when `--model` is set) emits a candidate `cond`, alive2 verifies it standalone, and `alive-tv-next` injects `llvm.assume(cond)` into the per-cut Transform.

The catalog of pre-verified rewrite templates is bundled with the binary (installed under `${install_prefix}/share/alive-tv-next/catalog/`) — no user-facing catalog flag. All of `alive-tv`'s flags (`--smt-to`, `--disable-undef-input`, `--src-fn`, `--tgt-fn`, …) are inherited.

On success, prints `Transformation seems to be correct!` and returns 0; on failure prints a per-cut error summary and returns 1.

## Reference tests

Seven `.srctgt.ll` test files live under [`../tests/alive-tv-next/`](../tests/alive-tv-next/) — the canonical test set the pilot must verify by end of Phase 4 (see PLAN.md).

## Next milestones

Per [`../PLAN.md`](../PLAN.md):

- **M1.4** — Example 1 verifies end-to-end. (Pending LLVM-trunk-against alive2 build.)
- **M1.5** — Example 1' verifies end-to-end (same mechanism, exercises `add` commutativity + `ptrtoint` identity path).
- **Phase 2 onward** — adds `match.{h,cpp}` (catalog), and later `assume.{h,cpp}` and `lift_lane.{h,cpp}` here.
