# tv-next

Alive-next's compositional translation validator. Pilot source lives here.

**Status:** M1.1 stub — CMake target wired, links against alive2's libraries, prints a usage message. The actual verification pipeline (diff / cut / per-cut alive2 / compose) lands in M1.2 onward.

See [`../PLAN.md`](../PLAN.md) for the staged plan and [`../IDEA.md`](../IDEA.md) for the design rationale.

## Layout

Flat, matching alive2's per-directory style (cf. `tools/`, `ir/`, `smt/`,
`llvm_util/`, `tv/` — each a flat directory with `.cpp` / `.h` files
directly inside).

```
tv-next/
  CMakeLists.txt    # registered via add_subdirectory(tv-next) in the
                    #   top-level CMakeLists.txt; see comments inside for
                    #   what alive2-side variables it expects.
  main.cpp          # CLI entry point. Currently a stub; future
                    #   milestones add ir_load.{h,cpp}, diff.{h,cpp},
                    #   cut.{h,cpp}, match.{h,cpp}, assume.{h,cpp},
                    #   verify.{h,cpp}, compose.{h,cpp} alongside it.
  README.md         # this file
```

## Building

This subdirectory is built as part of the standard alive2 build, gated on
`BUILD_LLVM_UTILS` (or `BUILD_TV`). Once the parent `CMakeLists.txt` has
`add_subdirectory(tv-next)`:

```bash
cd alive-next
mkdir -p build && cd build
cmake -GNinja -DCMAKE_PREFIX_PATH=~/llvm/build \
              -DBUILD_TV=1 -DCMAKE_BUILD_TYPE=Release ..
ninja alive-tv-next
./alive-tv-next --help
```

## Running

The stub accepts the target CLI shape but does no verification yet:

```bash
./alive-tv-next pre.ll post.ll
./alive-tv-next combined.srctgt.ll
./alive-tv-next combined.srctgt.ll --model gpt-4o      # later phases (LLM)
```

Input is a raw slice. Assumes (when needed for Phase 3+ rewrites) are
derived internally — `alive-tv-next` walks the slice, the hand-coded
proposer (or LLM, when `--model` is set) emits a candidate `cond`, alive2
verifies it standalone, and `alive-tv-next` injects `llvm.assume(cond)`
into the per-cut Transform.

The catalog of pre-verified rewrite templates is bundled with the binary
(installed under `${install_prefix}/share/alive-tv-next/catalog/`) — no
user-facing catalog flag. All of `alive-tv`'s flags (`--smt-to`,
`--disable-undef-input`, `--src-fn`, `--tgt-fn`, …) are inherited.

Returns 0 (clean exit) regardless of input — the return code does **not**
indicate a verification verdict at this stage.

## Reference tests

Seven `.srctgt.ll` test files live under [`../tests/alive-tv-next/`](../tests/alive-tv-next/) — the canonical test set the pilot must verify by end of Phase 4 (see PLAN.md).

## Next milestones

Per [`../PLAN.md`](../PLAN.md):

- **M1.2** — IR loading (`ir_load`) + per-line diff (`diff`) + single-instr cut builder (`cut`) + per-cut `TransformVerify::verify` dispatch.
- **M1.3** — Composition checker (identity comparison + dependency-chain check).
- **M1.4** — Example 1 verifies end-to-end.
- **M1.5** — Example 1' verifies end-to-end.
