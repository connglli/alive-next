# alive-next: Implementation Plan

This document pins down how `docs/design.md` gets built: languages, project
layout, the native binary, state on disk, the certificate checker, and the build
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
  llops/                C++, CMake; builds the llops binary
    src/
    test/               llops_test.py, driving the binary over JSON
  agent/                TypeScript on Pi; bun
    package.json        JS packages; bun.lock pins them
    src/tools/          one file per tool from design.md
    src/state/          store, goal tree, transactions, trajectory
    src/drivers/        alive-tv, llubi, llops wrappers
    src/cert/           certificate package assembly
    test/               bun test
  checker/              check.py (Python stdlib only)
  scripts/              deps.sh, visualize.py, build helpers
  rules/                pre-proved rule library (empty in v1)
  tests/e2e/            small LHS/RHS pairs run end-to-end
  build/                gitignored: our own build trees
  deps/                 gitignored: external sources, build trees, and
                        prefix/ with the tools we install
  .venv/                gitignored: the Python environment uv builds
  pyproject.toml        Python dev packages; uv.lock pins them
  .pre-commit-config.yaml  the checks, and .gitlint the commit rules
  config.json           machine-local (gitignored); config.example.json is
                        checked in
  Makefile              names the targets, delegates the work
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
  insert, erase, commute, retype, dedup, set_body, attrs) and return the new
  module text. The op catalog mirrors design.md; `attrs` is what the
  strengthen flow uses to put a proved fact on a parameter.
- `outline`: perform the split transformation: given a cut point and the
  value map, produce the outer module and the callee module.
- `inline`: the inverse: substitute a callee body back at the call site.
  Used by check.py to verify split faithfulness.
- `canon`: parse, renumber values canonically (`%0, %1, ...`), print. Turns
  "identical up to names" into "identical bytes".
- `analyze`: run an LLVM analysis (known bits, ranges, pointer facts) at a
  program point and report facts as JSON shaped for attributes and assumes.

Only `inline` and `canon` are verdict-critical (used by the certificate
checker); the rest are tier 2. This is documented here and in check.py rather
than enforced by separate binaries, since all subcommands share one library
anyway.

Every response is a JSON object with an `ok` field. A successful one carries
the subcommand's payload, a failed one an `error` with a stable `code` and a
message for the agent to read. The exit status repeats that answer, 0 for ok
and 1 for not ok, so a script can branch without parsing; 2 means the command
line itself was wrong.

Two rules keep the subcommands composable:

- A value is named by the token that names it in printed IR: `%3` for a slot,
  `%x` for a name, and `#7` for the instruction at index 7 of the body. The
  index form is the only way to reach an instruction that defines no value,
  such as a store or the terminator, and index 0 is the first instruction
  after the block label.
- Only `canon` renumbers. Every other subcommand hands back the names it was
  given, so a transaction can address the values it just created. Programs
  are canonicalized when they enter the store, which is what makes a hash a
  program's identity.

`edit` rejects anything that would leave the body ill formed, so a module
that comes out of llops parses, is straightline, and passes the LLVM
verifier. Rejection is the normal case during search, not an error path: the
diagnostic is the feedback.

Constraint: llops must build against the same LLVM version alive2 uses
(alive2 requires an RTTI/EH-enabled LLVM build), so the IR dialect we edit is
exactly the dialect alive-tv parses. `make install-deps` builds alive2,
llubi, and the LLVM they share from pinned refs, and llops builds against
that same install.

## External checkers

alive-tv and llubi are separate binaries, installed by `make install-deps`
into the prefix and found on PATH; `config.json` may override their paths and
records the expected version identifiers. TS drivers wrap them, and
every invocation is recorded verbatim (argv, flags, timeout) in the
trajectory and, for certified steps, in the certificate manifest, so replay
runs exactly what ran. llubi needs a small driver shape: run one function
with given argument values and initial pointed-to memory, report return
value, final observable memory, and UB events. If llubi does not support this
directly we wrap it (the wrapper lives in llops/ or as a llubi patch, decided
at integration time).

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

The `Makefile` is the entry point and owns nothing else: it names targets and
delegates. One component, one pair of targets, so `make llops` builds llops
and `make test-llops` tests it, and a component added later brings its own
pair. `make test` runs every suite, `make check` runs every hook over every
file, and `make help` lists the lot.

- `llops/`: CMake with `find_package(LLVM)`. `make llops` configures into
  `build/llops`, builds, and installs the binary into the prefix.
- `agent/`: bun throughout: `bun install`, `bun run`, `bun test`. Bun runs
  TypeScript directly, so there is no build step; `tsc --noEmit` is the
  typecheck.
- `checker/` and `scripts/`: plain Python, standard library only at runtime.
  The environment uv builds is for the dev tools, not for these.

Two directories, both inside the repository and both gitignored, hold
everything a build produces: `build/` for our own build trees and `deps/` for
the external tools, their sources and their build trees. `deps/prefix/bin`
holds every tool `make install-deps` installs, our own llops included, so
putting it first on PATH completes the environment; a tool that was already
good enough stays where it was found. `make clean` removes the first
directory, `make clean-deps` the second. `PREFIX=` and
`BUILD=` move them, `JOBS=` sets build parallelism, and `BUILD_TYPE=Debug`
switches the llops build.

### Checks and git hooks

The checks are not ours. [pre-commit](https://pre-commit.com) runs them, and
`.pre-commit-config.yaml` is the one place that says which upstream tool
checks what, each pinned to a revision that `pre-commit autoupdate` bumps in
a reviewed diff: clang-format for C++, ruff for Python, shellcheck and shfmt
for shell, whitespace and syntax hooks for the rest, and gitlint for commit
messages against the rules in [CLAUDE.md](../CLAUDE.md), with `.gitlint`
holding the settings. The clang-format is the one that ships with the LLVM
version we pin, so the formatter and the compiler agree.

The hooks are part of the dev environment, so `make deps-dev` provisions
both: the tools, from `uv.lock`, and the hooks in this clone. A hook that
rewrites a file fails the commit with the fix already applied, so the loop is
review, stage, commit again. The hooks see staged files only; `make check` is
the same set over the whole tree, which is what CI runs.

### Dependencies

`scripts/deps.sh` owns the external tools: LLVM, alive2, llubi, bun with the
JS packages, and uv with the Python ones. `make install-deps` installs the
ones that are missing and `make deps-status` reports what is there; a single
dependency is `make deps-llvm`, `make deps-alive2` and so on, and `FORCE=1`
reinstalls one that is already present.

What counts as missing is one check per dependency, so a copy that already
fits is left alone whoever installed it. For LLVM the check is the major
version and RTTI, because llops and alive2 have to link the same LLVM and
alive2 does not build without RTTI. For alive2 and llubi it is the binary
plus the LLVM version it reports. For the Python packages it is
`uv sync --check`, which compares the environment against `uv.lock` the way
`bun.lock` pins the JS side, and for the dev environment the same plus the
git hooks being in place. Prerequisites we do not install (git, cmake,
ninja, curl, a C++ compiler, and the Z3 development headers alive2 needs) are
reported with the command that installs them.

Four details are worth knowing before changing that script:

- The pins live at the top of it, so upgrading a dependency is one line and
  one reviewed diff. They are chosen so that one LLVM serves everything.
- llubi is a tool inside the LLVM tree, upstreamed after the release we pin.
  Its sources are fetched into our checkout at `llvm/tools/llubi`, where the
  LLVM build picks them up on its own, because its build file depends on
  in-tree targets that an out-of-tree build cannot resolve.
- alive2 builds `alive-tv` only with `-DBUILD_LLVM_UTILS=1`.
- uv provides the Python interpreter as well as the packages, so a machine
  needs no system Python for `make deps-py`. It is still needed for the
  stdlib-only scripts, `check.py` above all, which run under whatever
  `python3` a consumer has.
- `py` and `dev` share one environment: `py` installs what a run needs,
  `dev` adds what a contributor needs. Both sync with `--inexact`, so
  installing either never removes what the other put there.

The LLVM build is the expensive one, roughly an hour and tens of gigabytes.
Everything else is minutes. `LLVM_CONFIG=` names the LLVM to use when a
machine has several, which is how llops is built against a system LLVM
without provisioning the pinned one.

## Testing

- llops: `llops/test/llops_test.py`, one Python process driving the binary
  over the same JSON the agent's drivers send, because the interface under
  test is the protocol rather than the C++ API. Every subcommand is covered
  by what it accepts and what it rejects, and `outline` then `inline` then
  `canon` has to reproduce the original module.
- Agent: bun test for state, drivers (against stub binaries), and tool
  semantics; goal tree derivation replayed from recorded trajectories.
- check.py: golden certificate packages that must pass, and tampered ones
  that must fail: a disconnected chain, a bogus split, a modified program
  file, a wrong-direction step. The negative tests are the important ones.
- e2e: small LHS/RHS pairs through the full loop with a scripted (non-LLM)
  agent driver first, the real agent second.

## Implementation order

1. llops: validate, canon, edit ops, outline, inline, analyze; tests.
2. TS state layer: store, trajectory, goal tree derivation, transactions.
3. visualize.py against recorded trajectories.
4. Drivers: alive-tv, llubi, llops; config plumbing.
5. Tools wired into Pi; scripted-driver e2e.
6. Certificate assembly and check.py, with the tamper test suite.
7. The strengthen flow, over the facts analyze proposes.
8. Real-agent e2e on growing program sizes.
