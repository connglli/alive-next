# alive-next: Implementation Plan

This document pins down how `docs/design.md` gets built: languages, project layout, the native binary, state on disk, the certificate checker, and the build system. Where this document and design.md overlap, design.md defines *what* and this document defines *how*.

## Language split

One rule draws the boundary: does it need LLVM?

- **TypeScript** (on the Pi agent framework, https://github.com/earendil-works/pi, run with **bun**) owns everything stateful: the goal tree, the program store, transactions, the tool definitions the agent sees, drivers for external binaries, trajectory logging, and certificate assembly. All of it is tier 2 (untrusted for soundness), so keeping it in the agent-side language costs nothing. [agent.md](./agent.md) is how the agent is wired to Pi.
- **C++** owns everything that touches LLVM, packaged as one stateless binary, `llops`. IR text in, IR text or JSON facts out. No state between calls.

## Repository layout

```
alive-next/
  docs/                 design.md, implementation.md, llops.md, agent.md
  llops/                C++, CMake; builds the llops binary
    src/
    test/               llops_test.py, driving the binary over JSON
  agent/                TypeScript on Pi; bun
    package.json        JS packages; bun.lock pins them
    src/session.ts      a session directory and the moves that fill it
    src/agent.ts        the Pi agent: tools, loop, budget
    src/tools/          one file per tool from design.md
    src/state/          store, goal tree, transactions, trajectory
    src/drivers/        alive-tv, llubi, llops wrappers
    src/cert/           certificate package assembly
    e2e/                small LHS/RHS pairs, each with the script that
                        proves it
    test/               bun test
  checker/              check.py (Python stdlib only)
  scripts/              depman.sh, visualize.py, build helpers
  rules/                pre-proved rule library (empty in v1)
  deps/                 gitignored: where the toolchain is built unless
                        the configuration names somewhere else
  .venv/                gitignored: the Python environment uv builds
  pyproject.toml        Python dev packages; uv.lock pins them
  .pre-commit-config.yaml  the checks, and .gitlint the commit rules
  config.jsonc          machine-local (gitignored); config.example.jsonc is
                        checked in
  Makefile              names the targets, delegates the work
```

## llops: the native binary

Named after lli/llc/llubi. One binary, subcommands, invoked process-per-call with JSON over stdin/stdout. Parsing a module costs milliseconds while alive2 calls cost seconds to minutes, so a persistent server mode is not worth its complexity until profiling says otherwise.

[llops.md](./llops.md) is the contract: what each subcommand takes and answers, the shape a program has to have, how a request names a value, and what every error code means.

Constraint: llops builds against the toolchain's LLVM, the one alive-tv and llubi are built against, so the IR dialect we edit is exactly the dialect they parse. It is part of the toolchain rather than a thing beside it, and `make install-deps` builds it last.

## External checkers

alive-tv and llubi are separate binaries, built by `make install-deps` into the toolchain and found there by the layout below. TS drivers wrap them, and every invocation is recorded verbatim (argv, flags, timeout) in the trajectory and, for certified steps, in the certificate manifest, so replay runs exactly what ran. llubi needs a small driver shape: run one function with given argument values and initial pointed-to memory, report return value, final observable memory, and UB events. If llubi does not support this directly we wrap it (the wrapper lives in llops/ or as a llubi patch, decided at integration time).

Every alive-tv run carries `--disable-undef-input`. An undef input takes a fresh value at each use, so it refutes transformations that hold for every concrete input, and the counterexample it comes back with is not one an interpreter can be handed; a run certifies counterexamples by execution, so a refutation we cannot execute is a refutation we cannot use. It is also the difference between an answer and a timeout: `mul x, 8` to `shl x, 3` does not come back inside thirty seconds with undef inputs on, and takes milliseconds with them off. Poison inputs stay on, because a value at a cut point really can be poison and a proof that ignores that is not a proof.

## State on disk

A run lives in one session directory:

```
sessions/<id>/
  trajectory.jsonl      append-only source of truth
  store/<sha256>.ll     content-addressed programs, canonical text
  certificate/          produced only on a verdict
```

- **Store**: every program version is canonical text (as printed by `llops canon`) stored under its sha256. Filename equals hash, so integrity verification on load is free. This is the isolation guarantee from design.md: agent `bash`/`python` scratch work runs in a separate working directory, and even if it reaches the store, tampering is detected on the next load.
- **Goal tree**: not stored separately; it is derived state, rebuilt by replaying the trajectory. One source of truth, nothing to drift.

## trajectory.jsonl

One JSON object per line, appended synchronously by the framework's tool wrapper. The agent cannot skip, reorder, or rewrite entries; faithfulness is enforced by who holds the pen. Entries are flushed per event so a crash preserves an honest prefix, and each line carries the sha256 of the previous line, making the file a hash chain and tampering evident.

Event kinds:

- `run_start`: root program hashes, config snapshot, versions (LLVM, alive2, llubi, model), timestamp.
- `message`: every agent turn, verbatim.
- `tool_call` / `tool_result`: name, args, full result, duration; created programs referenced by store hash.
- `auto`: framework-initiated actions (eager cross-checks, root auto-replays) with outcomes.
- `verdict`: final outcome plus certificate path if one was produced.

## Certificate package and check.py

Produced on a verdict, per design.md. v1 has no rules library, so the checker's trusted surface is minimal:

- Python stdlib (hashing with hashlib, JSON, subprocess).
- alive-tv, rerun on every step and every leaf discharge in the recorded direction with generous timeouts.
- `llops inline` and `llops canon`, for split faithfulness only.

check.py walks the manifest and verifies:

1. Connectivity: each step's before-hash equals the current head, starting from the root LHS/RHS hashes; hashes are byte hashes of canonical text.
2. Steps and leaves: rerun alive-tv; result must be "correct". Leaf goals whose sides became identical are still rerun through alive-tv (they are chunk-sized, so this is cheap); the framework's alpha-equivalence fast path is a runtime optimization, not a trusted component.
3. Splits: `llops inline` the callee into the outer program, `llops canon` both sides, byte-compare against the parent's stored programs.
4. Composition: root verified iff every leaf and every split check passed.

The counterexample package is the symmetric llubi replay, also driven by check.py (or a sibling script) with the recorded input.

## visualize.py

`scripts/visualize.py`, Python stdlib only. Reads a session directory and emits one self-contained HTML file: no server, data embedded. Timeline of events down the side, filterable by kind; main panel shows the world at the selected moment: goal tree with statuses, the selected goal's current pair as a diff, and the event's detail (args, alive2 output, counterexample hints). Arrow keys and a scrubber travel back and forth; snapshots are precomputed by replaying the trajectory once. Built early, right after the state layer, because it doubles as our main debugging tool.

## Configuration

One `config.jsonc` at the repo root; no config directory. The dialect is JSONC, JSON with comments and trailing commas, so the checked-in example can carry every option with a note on what it is for; nothing but the agent reads these files, and what a run records is the resolved configuration as plain JSON. The split between config, CLI, and tool arguments follows one rule: the config file describes the machine, the CLI describes the run, tool arguments describe the call.

- **config.jsonc** (machine-local, gitignored; `config.example.jsonc` checked in, and read in its place when there is no config.jsonc): the model, named by a provider and an id from Pi's catalogue, or by a `base_url` for an OpenAI-compatible endpoint of your own with `api_key_env` naming the variable its key lives in; the `toolchain` directory the binaries were built in, `deps/` by default; default timeouts and budgets. Stable across runs, different on every machine.
- **CLI**: per-run facts: the LHS/RHS inputs, the session directory, `--config` to point elsewhere, and overrides for common knobs (`--model`, `--budget`, `--timeout-check`). Precedence: built-in defaults, then config file, then CLI.
- **Tool arguments**: per-call knobs the agent owns, like the `check` timeout; config supplies only the default and a cap.
- **Secrets** (API keys for Pi): environment variables only, never config or CLI, so they cannot leak into the trajectory.

This split is purely ergonomic, never a correctness question: `run_start` snapshots the fully resolved configuration and the certificate manifest records exact invocations, so a knob can move between config and CLI later at zero cost.

## Build system

The `Makefile` is the entry point and owns nothing else: it names targets and delegates. One component, one pair of targets, so `make llops` builds llops and `make test-llops` tests it, and a component added later brings its own pair. `make test` runs every suite, `make check` runs every hook over every file, and `make help` lists the lot.

- `llops/`: CMake with `find_package(LLVM)`. `make llops` configures into `<toolchain>/llops/build` against the toolchain's LLVM and builds there, so which LLVM a binary belongs to is visible from where it sits.
- `agent/`: bun throughout: `bun install`, `bun run`, `bun test`. Bun runs TypeScript directly, so there is no build step and `make agent` is the typecheck, `tsc --noEmit`.
- `checker/` and `scripts/`: plain Python, standard library only at runtime. The environment uv builds is for the dev tools, not for these.

`TOOLCHAIN` is the one location knob: `JOBS=` sets build parallelism and `BUILD_TYPE=Debug` switches the llops build, and that is the whole list. `make clean` removes the llops build tree. There is no target that removes a toolchain: it is expensive to rebuild, it may be shared with another checkout, and `rm -rf` on a directory the configuration names is not a thing to make convenient.

### Checks and git hooks

The checks are not ours. [pre-commit](https://pre-commit.com) runs them, and `.pre-commit-config.yaml` is the one place that says which upstream tool checks what, each pinned to a revision that `pre-commit autoupdate` bumps in a reviewed diff: clang-format for C++, biome for TypeScript and JSON, ruff for Python, shellcheck and shfmt for shell, whitespace and syntax hooks for the rest, and gitlint for commit messages against the rules in [CLAUDE.md](../CLAUDE.md), with `.gitlint` holding the settings. The clang-format is the one that ships with the LLVM version we pin, so the formatter and the compiler agree.

The hooks are part of the dev environment, so `make deps-dev` provisions both: the tools, from `uv.lock`, and the hooks in this clone. A hook that rewrites a file fails the commit with the fix already applied, so the loop is review, stage, commit again. The hooks see staged files only; `make check` is the same set over the whole tree, which is what CI runs.

### Dependencies

### The toolchain

llops, alive-tv and llubi all read and write LLVM IR, and they mean the same thing by a module only when they were built against the same LLVM. A mixed set does not fail cleanly: llops prints something alive-tv's parser does not know, or llubi disagrees about a corner of poison, and both read as the search going wrong rather than the install being wrong. So there is no supported way to mix them, and no path that takes a distribution's alive2 or a system LLVM. Everything LLVM-based is built from source, from the pins in `scripts/depman.sh`, against one LLVM.

A toolchain is one directory holding that build. One serves several checkouts, which is why it is a knob rather than a fixed place: building another costs an hour. Its layout is a contract between `scripts/depman.sh`, which builds into it, and `agent/src/toolchain.ts`, which reads from it:

```
<toolchain>/llvm-project/build/bin/llvm-config
<toolchain>/alive2/build/alive-tv
<toolchain>/llubi-legacy/build/llubi
<toolchain>/llops/build/llops
<toolchain>/toolchain.json      what was built, from which revisions
```

Where that directory is has one answer, resolved in one place: the `TOOLCHAIN` environment variable, then `toolchain` in `config.jsonc`, then `deps/` in the repository. `scripts/depman.sh toolchain` prints the answer and the Makefile asks it rather than repeating the rule, so a build and a run cannot end up pointed at different directories.

A run reads the toolchain before it proves anything: it asks each binary which LLVM it carries and stops if they disagree or one is missing, because every failure that check prevents is one that would otherwise be read as a bad proof. What it found, with `toolchain.json`, goes into `run_start`, so a verdict says which binaries produced it.

### Dependencies

`scripts/depman.sh` owns the toolchain, and the host tools beside it: bun with the JS packages, and uv with the Python ones. The host tools are not part of the toolchain and are installed where their own installers put them, because they are how we run our own code rather than how we read LLVM IR, and a machine that already has them keeps the one it has. `make install-deps` builds what is missing and then llops; `make deps-status` reports what is there; a single dependency is `make deps-llvm`, `make deps-alive2` and so on, and `FORCE=1` rebuilds one that is already present.

What counts as missing is one check per dependency, so a build that already fits is left alone. For LLVM it is an `llvm-config` in the toolchain reporting the pinned release, with RTTI, which alive2 needs. For alive2 and llubi it is the binary being there and reporting that same release. For the Python packages it is `uv sync --check`, which compares the environment against `uv.lock` the way `bun.lock` pins the JS side, and for the dev environment the same plus the git hooks being in place. Prerequisites we do not install (git, cmake, ninja, curl, a C++ compiler, and the Z3 development headers alive2 needs) are reported with the command that installs them.

Four details are worth knowing before changing that script:

- The pins live at the top of it, so upgrading a dependency is one line and one reviewed diff. Moving the LLVM pin means rebuilding everything below it: the pins are one toolchain, not three.
- LLVM is built with shared libraries, RTTI and assertions. RTTI is alive2's requirement, the assertions are what make a malformed module say so instead of failing later, and shared libraries keep four binaries from costing several gigabytes each.
- llubi is the out-of-tree interpreter at dtcxzyw/llvm-ub-aware-interpreter, not the newer rewrite living in `llvm/tools`, which is not stable yet.
- alive2 builds `alive-tv` only with `-DBUILD_LLVM_UTILS=1`.
- uv provides the Python interpreter as well as the packages, so a machine needs no system Python for `make deps-py`. It is still needed for the stdlib-only scripts, `check.py` above all, which run under whatever `python3` a consumer has.
- `py` and `dev` share one environment: `py` installs what a run needs, `dev` adds what a contributor needs. Both sync with `--inexact`, so installing either never removes what the other put there.

The LLVM build is the expensive one, roughly an hour and tens of gigabytes. Everything else is minutes, and llops is seconds.

## Testing

- llops: `llops/test/llops_test.py` drives the binary over its JSON protocol, which is the interface under test; see [llops.md](./llops.md).
- Agent: bun test for state, drivers (against stub binaries), and tool semantics; goal tree derivation replayed from recorded trajectories.
- check.py: golden certificate packages that must pass, and tampered ones that must fail: a disconnected chain, a bogus split, a modified program file, a wrong-direction step. The negative tests are the important ones.
- e2e: `agent/e2e/` holds a pair and the script that proves it, one file per scenario, and each scenario is run twice by `bun test`: once against a checker that agrees with everything, which tests that the moves are still moves the framework makes and needs no solver installed, and once against alive-tv, which is the run that means something. `make e2e` runs them for real into `sessions/`, which is where the visualizer and the certificate checker get something to read. A model runs the same scenarios later, through the same operations.

## Implementation order

1. llops: validate, canon, edit ops, outline, inline, analyze; tests.
2. The llops driver, then the state layer it feeds: store, trajectory, goal tree derivation.
3. visualize.py against recorded trajectories.
4. The alive-tv and llubi drivers; config plumbing.
5. Steps, transactions, splits, and the strengthen flow over the facts analyze proposes, against a stub alive-tv.
6. Tools wired into Pi; scripted-driver e2e.
7. Certificate assembly and check.py, with the tamper test suite.
8. Real-agent e2e on growing program sizes.
