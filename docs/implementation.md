# alive-next: Implementation Plan

This document pins down how `docs/design.md` gets built: languages, project
layout, the native tool, state on disk, the certificate checker, and the build
system. Where this document and design.md overlap, design.md defines *what*
and this document defines *how*.

## Language split

One rule draws the boundary: does it need LLVM?

- **TypeScript** (on the Pi agent framework,
  https://github.com/earendil-works/pi, run with **bun**) owns everything
  stateful: the goal tree, the program store, transactions, the tool
  definitions the agent sees, drivers for external binaries, trajectory
  logging, and certificate assembly. All of it is tier 2 (untrusted for
  soundness), so keeping it in the agent-side language costs nothing.
- **C++** owns everything that touches LLVM, packaged as one stateless
  binary, `llops`. IR text in, IR text or JSON facts out. No state between
  calls.

## Repository layout

```
alive-next/
  docs/                 design.md, implementation.md
  native/               C++, CMake; builds llops
    src/
    test/               lit tests over .ll fixtures
  agent/                TypeScript on Pi; bun
    src/tools/          one file per tool from design.md
    src/state/          store, goal tree, transactions, trajectory
    src/drivers/        alive-tv, llubi, llops wrappers
    src/cert/           certificate package assembly
    test/               bun test
  checker/              check.py (Python stdlib only)
  scripts/              visualize.py, setup and build helpers
  rules/                pre-proved rule library (empty in v1)
  tests/e2e/            small LHS/RHS pairs run end-to-end
  deps/                 gitignored: clones and build trees made by
                        make install-deps
  config.json           machine-local (gitignored); config.example.json is
                        checked in
  Makefile              orchestrates everything
```

## llops: the native binary

Named after lli/llc/llubi. One binary, subcommands, invoked process-per-call
with JSON over stdin/stdout. Parsing a module costs milliseconds while alive2
calls cost seconds to minutes, so a persistent server mode is not worth its
complexity until profiling says otherwise.

Subcommands:

- `validate`: parse a module, check the straightline v1 invariants, report
  diagnostics.
- `edit`: apply one semantic edit op (swap, move, substitute, replace,
  insert, erase, commute, retype, dedup, set_body) and return the new module
  text plus diagnostics. The op catalog mirrors design.md.
- `outline`: perform the split transformation: given cut points and the value
  map, produce the outer module and the callee module.
- `inline`: the inverse: substitute a callee body back at the call site.
  Used by check.py to verify split faithfulness.
- `canon`: parse, renumber values canonically (`%0, %1, ...`), print. Turns
  "identical up to names" into "identical bytes".
- `analyze`: run an LLVM analysis (known bits, ranges, alias) at a program
  point and report facts as JSON shaped for attributes and assumes.

Only `inline` and `canon` are verdict-critical (used by the certificate
checker); the rest are tier 2. This is documented here and in check.py rather
than enforced by separate binaries, since all subcommands share one library
anyway.

Constraint: llops must build against the same LLVM version alive2 uses
(alive2 requires an RTTI/EH-enabled LLVM build), so the IR dialect we edit is
exactly the dialect alive-tv parses. `make install-deps` builds alive2,
llubi, and the LLVM they share from pinned refs, and llops builds against
that same install.

## External checkers

alive-tv and llubi are separate binaries, installed by `make install-deps`
and found on PATH by default; `config.json` may override their paths and
records the expected version identifiers. TS drivers wrap them, and
every invocation is recorded verbatim (argv, flags, timeout) in the
trajectory and, for certified steps, in the certificate manifest, so replay
runs exactly what ran. llubi needs a small driver shape: run one function
with given argument values and initial pointed-to memory, report return
value, final observable memory, and UB events. If llubi does not support this
directly we wrap it (wrapper lives in native/ or as a llubi patch, decided at
integration time).

## State on disk

A run lives in one session directory:

```
sessions/<id>/
  trajectory.jsonl      append-only source of truth
  store/<sha256>.ll     content-addressed programs, canonical text
  certificate/          produced only on a verdict
```

- **Store**: every program version is canonical text (as printed by `llops
  canon`) stored under its sha256. Filename equals hash, so integrity
  verification on load is free. This is the isolation guarantee from
  design.md: agent `bash`/`python` scratch work runs in a separate working
  directory, and even if it reaches the store, tampering is detected on the
  next load.
- **Goal tree**: not stored separately; it is derived state, rebuilt by
  replaying the trajectory. One source of truth, nothing to drift.

## trajectory.jsonl

One JSON object per line, appended synchronously by the framework's tool
wrapper. The agent cannot skip, reorder, or rewrite entries; faithfulness is
enforced by who holds the pen. Entries are flushed per event so a crash
preserves an honest prefix, and each line carries the sha256 of the previous
line, making the file a hash chain and tampering evident.

Event kinds:

- `run_start`: root program hashes, config snapshot, versions (LLVM, alive2,
  llubi, model), timestamp.
- `message`: every agent turn, verbatim.
- `tool_call` / `tool_result`: name, args, full result, duration; created
  programs referenced by store hash.
- `auto`: framework-initiated actions (eager cross-checks, root
  auto-replays) with outcomes.
- `verdict`: final outcome plus certificate path if one was produced.

## Certificate package and check.py

Produced on a verdict, per design.md. v1 has no rules library, so the
checker's trusted surface is minimal:

- Python stdlib (hashing with hashlib, JSON, subprocess).
- alive-tv, rerun on every step and every leaf discharge in the recorded
  direction with generous timeouts.
- `llops inline` and `llops canon`, for split faithfulness only.

check.py walks the manifest and verifies:

1. Connectivity: each step's before-hash equals the current head, starting
   from the root LHS/RHS hashes; hashes are byte hashes of canonical text.
2. Steps and leaves: rerun alive-tv; result must be "correct". Leaf goals
   whose sides became identical are still rerun through alive-tv (they are
   chunk-sized, so this is cheap); the framework's alpha-equivalence fast
   path is a runtime optimization, not a trusted component.
3. Splits: `llops inline` the callee into the outer program, `llops canon`
   both sides, byte-compare against the parent's stored programs.
4. Composition: root verified iff every leaf and every split check passed.

The counterexample package is the symmetric llubi replay, also driven by
check.py (or a sibling script) with the recorded input.

## visualize.py

`scripts/visualize.py`, Python stdlib only. Reads a session directory and
emits one self-contained HTML file: no server, data embedded. Timeline of
events down the side, filterable by kind; main panel shows the world at the
selected moment: goal tree with statuses, the selected goal's current pair as
a diff, and the event's detail (args, alive2 output, counterexample hints).
Arrow keys and a scrubber travel back and forth; snapshots are precomputed by
replaying the trajectory once. Built early, right after the state layer,
because it doubles as our main debugging tool.

## Configuration

One `config.json` at the repo root; no config directory. The split between
config, CLI, and tool arguments follows one rule: the config file describes
the machine, the CLI describes the run, tool arguments describe the call.

- **config.json** (machine-local, gitignored; `config.example.json` checked
  in): optional path overrides for alive-tv, llubi, and llvm-config (by
  default all are found on PATH); expected version identifiers; default
  timeouts and budgets. Stable across runs, different on every machine.
- **CLI**: per-run facts: the LHS/RHS inputs, the session directory,
  `--config` to point elsewhere, and overrides for common knobs (`--model`,
  `--budget`, `--timeout-check`). Precedence: built-in defaults, then config
  file, then CLI.
- **Tool arguments**: per-call knobs the agent owns, like the `check`
  timeout; config supplies only the default and a cap.
- **Secrets** (API keys for Pi): environment variables only, never config or
  CLI, so they cannot leak into the trajectory.

This split is purely ergonomic, never a correctness question: `run_start`
snapshots the fully resolved configuration and the certificate manifest
records exact invocations, so a knob can move between config and CLI later
at zero cost.

## Build system

- `native/`: CMake, `find_package(LLVM)`, lit for tests.
- `agent/`: bun throughout: `bun install`, `bun run`, `bun test`. Bun runs
  TypeScript directly, so there is no build step; `tsc --noEmit` runs as the
  typecheck in CI and `make check`.
- `checker/` and `scripts/`: plain Python, stdlib only at runtime, no pip;
  the dev venv below exists for the test harness, not for these scripts.
- Top-level `Makefile` targets: `install-deps` (below), `native`, `agent`,
  `check` (typecheck plus lint), `test` (unit), `e2e`, and `package`
  conveniences.

### make install-deps

One idempotent target that provisions everything, composed of sub-targets
that also run individually:

- `deps-llvm`: clone llvm-project at the pinned ref into `deps/`, build with
  `-DLLVM_ENABLE_RTTI=ON -DLLVM_ENABLE_EH=ON` (required by alive2), host
  target only, Release with assertions, install into the prefix.
- `deps-alive2`: clone alive2 at the pinned ref, build against that LLVM,
  copy `alive-tv` into the prefix. Requires Z3 development headers; the
  target checks for them and stops with instructions rather than building
  Z3 itself.
- `deps-llubi`: clone llubi at the pinned ref, build against the same LLVM,
  copy the binary into the prefix.
- `deps-bun`: install bun via the official installer if not present.
- `deps-js`: `bun install` in `agent/`.
- `deps-venv`: create `.venv` and install dev-only Python dependencies (lit,
  pytest). check.py and visualize.py stay stdlib-only at runtime.

Contract: `make install-deps PREFIX=$HOME/.local` (the default). Afterwards
`bun`, `alive-tv`, `llubi`, and `llvm-config` are on PATH via the prefix's
`bin`, and llops' CMake locates LLVM through `llvm-config --cmakedir`.
Pinned refs for LLVM, alive2, and llubi live at the top of
`scripts/install-deps.sh`, so upgrading a dependency is one reviewed diff.
Clones and build trees live in `deps/` (gitignored); `JOBS=` controls build
parallelism and ccache is used when found. The LLVM build is the expensive
one (roughly an hour and tens of GB); every sub-target skips work that is
already done.

## Testing

- llops: lit tests, IR fixture in, expected IR or JSON out; a roundtrip
  property test that `outline` then `inline` then `canon` reproduces the
  original module.
- Agent: bun test for state, drivers (against stub binaries), and tool
  semantics; goal tree derivation replayed from recorded trajectories.
- check.py: golden certificate packages that must pass, and tampered ones
  that must fail: a disconnected chain, a bogus split, a modified program
  file, a wrong-direction step. The negative tests are the important ones.
- e2e: small LHS/RHS pairs through the full loop with a scripted (non-LLM)
  agent driver first, the real agent second.

## Implementation order

1. llops skeleton: validate, canon, edit ops, outline, inline; lit tests.
2. TS state layer: store, trajectory, goal tree derivation, transactions.
3. visualize.py against recorded trajectories.
4. Drivers: alive-tv, llubi, llops; config plumbing.
5. Tools wired into Pi; scripted-driver e2e.
6. Certificate assembly and check.py, with the tamper test suite.
7. analyze subcommand and the strengthen flow.
8. Real-agent e2e on growing program sizes.
