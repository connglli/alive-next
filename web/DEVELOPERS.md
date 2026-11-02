# Developing the web interface

[README.md](./README.md) covers building and using the interface. This document owns its implementation, verification and publishing details.

## Build pipeline

Both `build.sh` and [scripts/build-tools.sh](./scripts/build-tools.sh) require `make deps-status` to succeed before downloading or compiling. The tool builder provisions the pinned Emscripten SDK and Z3 and compiles the native tools for WebAssembly. [scripts/bundle-site.ts](./scripts/bundle-site.ts) bundles the UI and workers and packages the static site. The main entry point also compares the browser checkers with their native tools, installs the web packages from their lockfile and typechecks the browser code.

The build reads LLVM, alive2 and llubi source checkouts from the toolchain selected by `scripts/depman.sh toolchain` and checks their revisions against that script's pins.

Downloads and compiled tools are cached under `web/build/`. The packager generates a replacement in a temporary directory before replacing `web/dist/`; failure preserves the working site. Scripts, workers, manifests, styles and checker assets have content-addressed filenames to prevent caches from mixing builds.

The header identifies the build's Git revision, with a `-dirty` suffix for uncommitted tracked changes.

### Toolchain patches

The tool builder applies the following patches to isolated source checkouts under `web/build/`. It reuses already-applied patches on repeated builds. The engine and native toolchain remain unchanged.

* [z3.patch](./patches/z3.patch) replaces Z3's threaded timer with the [polling implementation](./cmake/z3-timer.inc) for single-threaded WebAssembly. Resource-limit polls deliver expired timers' cancellation callbacks. The patch also adapts Z3 4.8.12, the native comparison's library version, to the web build's CMake, Python and C++ compiler: it replaces `distutils`, fixes string escapes and template errors, and annotates unused variables.
* [alive2.patch](./patches/alive2.patch) fixes a pointer/iterator comparison in LLVM global-name parsing. `strtoul` returns a pointer, while Emscripten's libc++ wraps `string_view` iterators. Comparing against `name.data() + name.size()` preserves the intended end-of-string check and allows compilation.
* [llubi.patch](./patches/llubi.patch) fixes volatile-memory hashing in the optional llubi build. `Size` is a 32-bit `size_t` on wasm32, so `Size << 32` has undefined behavior. Casting to `uint64_t` before shifting preserves the intended 64-bit hash calculation.

The Z3 build also uses `-Dsmt=z3_smt` to separate its private SMT namespace from alive2's when linking them statically.

## Runtime

[src/app.ts](./src/app.ts) wires user actions and state updates. [Views](./src/views/) own DOM rendering and event bindings; [controllers](./src/controllers/) own session lifecycles, file reads and export cancellation. [Services](./src/services/) provide checker execution, report-worker requests and downloads. [src/state.ts](./src/state.ts) defines the run lifecycle and checker records independently of the DOM. Views receive state and callbacks rather than locating controllers or workers through globals.

[src/alive-simple.worker.ts](./src/alive-simple.worker.ts) provides a command/result interface around the existing session and searcher. The build maps their file, path, OS, hashing and process operations to browser adapters in [src/platform/](./src/platform/). Session files and trajectories stay in memory. The UI displays snapshots of the session's goal tree.

Show details opens a snapshot using the visualizer's own HTML, CSS and JavaScript from `scripts/visualize_ui.*`. The page retains the session's trajectory and immutable programs so the view remains available after Stop. [src/visualizer-data.ts](./src/visualizer-data.ts) uses the engine's goal replay to prepare the visualizer's data, with difflib's Python-compatible unified diffs. Snapshot preparation runs in a separate worker; the resulting page lives in an iframe so its styles and inspector stay isolated. Its highlighter and styles are embedded for offline viewing.

Save in Goal tree downloads a ZIP snapshot containing the original `module.ll`, `session/trajectory.jsonl`, all immutable programs under `session/store/`, and a standalone `session/session.html`. For a proved or refuted root, [src/certificate.ts](./src/certificate.ts) uses the native manifest builder to include `session/certificate/` with the manifest, its required programs and the unchanged `kernel/check.py`. Required programs are checked against their hashes before packaging. Unknown runs retain the session snapshot and explain the absent certificate in `README.txt`.

[src/archive.ts](./src/archive.ts) packages these files in the same worker used by Show details. The original log lines preserve their hash chain, and the extracted session directory can be passed to `scripts/visualize.py`. The certificate is independently replayable with Python and native checker binaries; the ZIP's README gives the command. Editing the input or starting another run cancels an unfinished download.

The Checks view records completed alive2, `llops respected` and `llops reshaped` attempts with their elapsed time and raw output, including attempts that do not prove refinement. Its counter includes all three checker types. Other llops commands perform parsing, editing or analysis and are omitted from this view.

The page owns checker workers so it can terminate them even when a synchronous Wasm call blocks the search. Worker termination enforces the overall wall-clock limit. Run budgets are validated in the UI and worker, with shared definitions in [src/limits.ts](./src/limits.ts). The search disables verified-rule rewriting. Refutations require alive2; concrete llubi replay is outside the browser interface.

The [web llops entry point](./cmake/llops-main.cpp) uses LLVM to parse and verify the combined input module before splitting it. The split preserves shared declarations, globals and attributes, gives both entries a common name, and rejects ordinary or metadata references to the entries before removing either body.

Each checker command runs in a fresh Emscripten instance because LLVM's command-line registry and solver globals have process lifetime. Node probes and browser workers share [src/wasm.mjs](./src/wasm.mjs). Compiled modules are cached and shared with fresh instances; failed asset loads can be retried. The loader decompresses Wasm without requiring custom HTTP headers or shared memory.

The web UI and visualizer share palette, fonts, panel styling and code-layout overrides through [scripts/visualize_theme.css](../scripts/visualize_theme.css). Both use Highlight.js 11.12.0's LLVM grammar and GitHub theme. The web build bundles the grammar and theme locally; [src/highlight.ts](./src/highlight.ts) applies them to the editor and inspected source/target, with a plain-text fallback. Layout-specific CSS stays in [static/style.css](./static/style.css).

## Checks

The main build runs the llops and alive2 probes. From the repository root, individual tools can be built and probed with:

```sh
./web/scripts/build-tools.sh llops --jobs 2
node web/scripts/probe.mjs llops
./web/scripts/build-tools.sh z3timer
```

The builder accepts `llops`, `alive2`, `llubi`, `all`, or `z3timer`. Optional llubi WebAssembly support is built with `llubi` or `all`; the UI does not load it. The probe accepts tool names or no argument for all tools and writes `web/build/probe.json` (or `probe-<tool>.json` for one tool). It records artifact sizes, cold-process wall time, Node peak resident memory, Wasm initialization and execution time, and linear-memory allocation after execution. Node measurements do not establish browser memory use.

After building, run the browser-code and packaging checks from `web/`:

```sh
bun run check
bun run test:limits
bun run test:controllers
bun run test:visualizer
bun run test:build
```

With the Python server running, test the UI with an installed Chrome or Chromium:

```sh
bun run test:browser
```

Set `CHROME_BIN` when the executable is not `/usr/bin/google-chrome`, or `WEB_TEST_URL` to test another served URL. Browser regressions cover proofs, counterexamples, invalid input, splitting, goal inspection, cancellation, decomposition, asset retries, input invalidation and the mobile layout. The details adapter is compared against the native visualizer's regression sessions. Packaging regressions check that failed builds preserve the site.

## GitHub Pages

Keep source on `main` and publish the built site from a separate `web` branch at https://connglli.github.io/alive-next/.

1. From the repository root on the source branch, run `./web/build.sh`.
2. Copy the contents of `web/dist/` to the root of the `web` branch, including `.nojekyll`. `index.html` must be at the branch root.
3. Commit and push the publishing branch when ready.
4. In Settings → Pages → Build and deployment, set Source to Deploy from a branch, select `web` and `/(root)`, then Save.
