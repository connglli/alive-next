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
  engine/               the interactive framework; TypeScript on bun
    package.json        JS packages; bun.lock pins them
    core/               the framework: session, state, drivers, toolchain
      session.ts        a session directory and the moves that fill it
      scenario.ts       a scripted proof: a pair and the moves that prove it
      prove.ts          run one scenario to a verdict
      state/            store, goal tree, transactions, counterexamples,
                        trajectory
      drivers/          alive-tv, llubi, llops wrappers
    agent/              the Pi agent: the model in front of the engine
      prompt.ts         the rules of the game, naming no tool
      budget.ts         what a run may spend, from --max-steps/--max-seconds
      model.ts          which of Pi's models a run talks to
      print.ts          the run as it happens, in plain text, for --print
      agent.ts          the Pi runtime: tools, prompt, stop, recording
      main.ts           the CLI: one pair, drawn by Pi's TUI or by --print
      tools/            one file per tool from design.md
    cert/               certificate package assembly
      main.ts           certify a finished session
      manifest.ts       the manifest: what the proof was, pruned
    examples/           small LHS/RHS pairs, each with the script that
                        settles it
    test/               bun test
  scripts/              depman.sh, visualize.py, check.py, build helpers
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

Constraint: llops builds against the toolchain's LLVM, the one alive-tv and llubi are built against, so the IR dialect it edits is the dialect they parse. It is part of the toolchain, and `make install-deps` builds it last.

## External checkers

alive-tv and llubi are separate binaries, built by `make install-deps` into the toolchain and found there by the layout below. TS drivers wrap them, and every invocation is recorded verbatim (argv, flags, timeout) in the trajectory and, for certified steps, in the certificate manifest, so replay runs exactly what ran. llubi needs a small driver shape: run one function with given argument values and initial pointed-to memory, report return value, final observable memory, and UB events. If llubi does not support this directly we wrap it (the wrapper lives in llops/ or as a llubi patch, decided at integration time).

alive-tv is run with the SMT timeout and whatever flags the caller passes, and nothing else. `--disable-undef-input` is not passed: for a callee goal it assumes what the cut has to prove.

Definedness is stated in the IR. A root pair carries `noundef` on the parameters it takes to be defined, and a callee's interface is proved defined at the cut by strengthening, which certifies an assume in the caller before putting the same fact on the parameter.

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

Reading is a move like any other. `status` answers with the tree, each goal's status and heads and the transaction if one is open, and names no program text. `show` answers with one goal and the text of both sides, each side also listing every program it has been. `program` answers with any of those, by the name the tree gave it or by its hash.

A program's value references are the program's own, so a caller reads a side before addressing anything in it: `begin` answers with the body it opened on, an applied edit with the body as it now stands, and a refused edit with the body it refused, which is where the reference it could not find was meant to be.

`revert` moves a side's head back to a program that side has been. The later steps stay in the log, unused, and whatever the proof they carried had settled comes undone with them. It refuses a program the side has never been, the head itself, and a side with a transaction open on it.

## trajectory.jsonl

One JSON object per line, appended synchronously by the framework's tool wrapper. The agent cannot skip, reorder, or rewrite entries; faithfulness is enforced by who holds the pen. Entries are flushed per event so a crash preserves an honest prefix, and each line carries the sha256 of the previous line, making the file a hash chain and tampering evident.

Event kinds:

- `run_start`: root program hashes, config snapshot, versions (LLVM, alive2, llubi, model), timestamp.
- `message`: every agent turn, verbatim.
- `tool_call` / `tool_result`: name, args, full result, duration; programs referenced by store hash rather than repeated, whether the move created one or only read it.
- `auto`: framework-initiated actions (eager cross-checks, root auto-replays) with outcomes.
- `verdict`: final outcome plus certificate path if one was produced.

## The agent

`engine/agent/` is the one part of the engine that drives a model, and nothing verification-critical is in it: a bug here spends tokens and produces no proof, and cannot produce a wrong one. `make agent SRC=a.ll TGT=b.ll` proves one pair with the configured model, writing the session directory an example writes.

The tool surface is stated rather than discovered. Pi's defaults are dropped, the allowlist names every tool that exists, ours arrive as custom tools, and the resource loader is told to read no extensions, skills, prompts, themes or context files from the machine, so what a run can do is what `agent.ts` says and not what is installed beside it. Tools run sequentially, because they mutate one goal tree. The shell and the file tools are built for the run's scratch directory.

The loop stops on a verdict or on the budget. A tool that settles the root sets Pi's `terminate` hint, and the same test runs again after the turn, since Pi honours the hint only when every result in a batch carries it. The budget is `--max-steps` and `--max-seconds`, unbounded when neither is given, and running out is not a failure: "unknown" is one of the three outputs.

`make agent` opens Pi's TUI, which is also where the model and the thinking level are steered from. `bun run agent --print` streams the same run to stdout for a pipe or a log, through `engine/agent/print.ts` rather than Pi's print mode, which prints one last message once a run is over and so prints nothing for a proof that ends on a tool call. Drawing belongs to the entry point rather than to `agent.ts`, which builds a session runtime and stays quiet, so a caller with a screen of its own can draw the same events differently.

What the model said reaches `trajectory.jsonl` as `message` entries and compaction as an `auto` entry. Its tool calls are already there, since every tool of ours writes itself through the session and Pi's own arrive inside the assistant message.

## Certificate package and check.py

A settled run writes one, into `<session>/certificate`: `programs/` named by content hash, `manifest.json`, and a copy of `scripts/check.py`. `make cert SESSION=sessions/<id>` builds it from a session that has already finished, and `make examples` writes one for each example it settles. `engine/cert/` assembles it from the trajectory: the goal tree says which pairs survived, the log says what certified each move, and what the run abandoned does not appear.

A verified run's manifest is a version, the verdict, the root goal, the toolchain `run_start` recorded, and one entry per goal:

- `start` and `end`, the pairs the goal began and ended with, as hashes.
- `steps`, in the order they happened. A `checked` step names the side it moved, the hash it moved from and to, and the alive-tv options the run passed beyond its timeout. A `strengthen` step names the pair on each end and the outer step that stands behind it.
- `discharge`, either `checked` or a `split` naming the outlined function and the two children.

check.py needs Python, alive-tv for a proof, llubi for a counterexample, and llops for the subcommands each needs. It takes their paths from the manifest, which records where the run found them and which LLVM each carried, falling back to the name on PATH and saying which it used and whether that is the LLVM the run had. It reads a program only from a file whose name is its hash. For a proof it verifies:

1. Connectivity: each step starts at the current head, and the steps add up to `end`.
2. Steps: rerun alive-tv in the direction the side implies, a src step forwards and a tgt step backwards. The result must be correct.
3. Leaves: rerun alive-tv on the pair the goal ended with.
4. Cuts: `llops inline` the callee's starting program into the outer's, `llops canon` it, and compare bytes against the pair the parent ended with. The declaration of the outlined function in the outer's final programs must match its definition in the callee's, parameter attributes included, which is what a `strengthen` step rests on along with the outer's chain being checked like any other.
5. Composition: the root is verified when every goal reached under it passed.

A refuted run's manifest is a version, the verdict, the root goal, the toolchain, the pair the run was asked about, the input, and what the run saw diverge. The pair is the root's first, not the one the run reached: a step may overshoot, so only the original pair is the translation. check.py wraps each side in a `llops harness` around that input, runs both under llubi, and decides for itself. It refuses a src that is free to choose what it does, `undef` or `freeze` in a straightline program, since one run of such a src is one behaviour among several and the tgt is allowed any of them. Otherwise three rules settle it. A src with UB on the input allows every target, so it settles nothing. A tgt with UB where the src returned is a refutation, and so is any observation the two disagree on. Poison needs no rule of its own: the harness stores what the entry returns and storing poison is UB, so a poison result arrives as UB on the side that produced it. It reports what it ran in the shape alive2 reports a counterexample in: the error, the input one parameter per line, and what each side observed or the UB it hit. Which error it is comes from where the tgt stopped. The harness stores what the entry returned so it can be observed, and that store is the only UB the harness itself can have, so stopping there is a poison result, `Target is more poisonous than source`, and stopping anywhere else is UB the tgt has of its own, `Source is more defined than target`.

`make test-scripts` builds packages and bends them: a program that is not what its name says, a chain that does not start where it says, a step recorded on the wrong side, a cut whose halves do not inline back, a cut whose halves disagree about the callee, an attribute on a goal that is not a callee, a step of a kind the checker does not know, and, for a counterexample, an input the two programs agree on and one the src has UB on.

## visualize.py

`scripts/visualize.py`, Python standard library only. `make visualize SESSION=sessions/<id>` reads a session directory and writes `session.html` beside its trajectory: no server, and the trajectory, every program a goal held and where each goal stood after each event are embedded in the page.

The timeline runs down the side, one line per move, with a tool call and its result on the same line. A switch per tool and per other event kind hides what is not being read, and arrow keys, a click or the scrubber move through it. Moving to a line selects the pair it is about: the one that move produced, or the one held by the goal it names.

The panel beside it draws the derivation at the selected event. A node is a pair a goal held, an edge is the move that led from one pair to the next, and a cut branches into its two halves. The edge carries the move's name and the side it touched, and clicking it goes to the event that made it; clicking the node it points at selects that pair without moving the timeline. A node is coloured by where its goal stands while that pair is the one it holds, green for proved, red for open, amber for cut and doubled for refuted, and faded once the run has moved past it. A caret folds a subtree and says how many pairs it hides. Selecting a pair shows its two programs side by side, under a line naming the move that produced it: the goal, the tool, the side it touched, and the pair it came from. The side that moved shows what it was, an arrow, and what it became; the side that did not says so and is shown once. The event as it was recorded sits under them, alive2 output included.

The fold it replays with is the one `engine/core/state/goals.ts` applies, written a second time. A session that records a verdict is checked against the verdict the fold reaches, and a mismatch is refused rather than drawn; an effect the fold cannot apply stops it, and the page says where. `python3 scripts/visualize_test.py` covers both, over sessions it builds.

## Configuration

One `config.jsonc` at the repo root; no config directory. The dialect is JSONC, JSON with comments and trailing commas, so the checked-in example can carry every option with a note on what it is for; nothing but the agent reads these files, and what a run records is the resolved configuration as plain JSON. The split between config, CLI, and tool arguments follows one rule: the config file describes the machine, the CLI describes the run, tool arguments describe the call.

- **`~/.pi/agent/`** (the machine, shared with `pi`): `auth.json` for credentials, kept `0600` and written by `/login`, which is the only thing that writes outside the checkout; `models.json` for providers the machine can reach; `settings.json` for personal defaults. Credentials stay outside the checkout because the agent is untrusted and its shell starts inside it, so a key kept there would be one `cat` away.
- **`.pi/`** (the project, in the repository, gitignored): `extensions/` declares the providers this checkout proves with, `settings.json` says which is the default. These are Pi's own project layer, so `pi` run in this repository reads the same files. A local server such as Ollama or vLLM is declared as an extension there, since Pi reads models from one file per machine and has no project counterpart; [agent.md](./agent.md#configuration) carries the recipe.
- **config.jsonc** (machine-local, gitignored; `config.example.jsonc` checked in, and read in its place when there is no config.jsonc): the `toolchain` directory the binaries were built in, `deps/` by default, and the default timeouts. Stable across runs, different on every machine. A section it does not carry is an error rather than a setting that does nothing.
- **CLI**: per-run facts: the LHS/RHS inputs, the session directory, `--max-steps` and `--max-seconds`, and `--model`, `--provider` and `--thinking`, which resolve through Pi's own `resolveCliModel` so a reference means here what it means in `pi`.
- **Tool arguments**: per-call knobs the agent owns, like the `check` timeout; config supplies only the default and a cap.

`engine/core/config.ts` carries the toolchain and the timeouts, and nothing that belongs to the agent: what bounds a model is a per-run choice, so `engine/agent/budget.ts` takes it from the command line.

This split is purely ergonomic, never a correctness question: `run_start` snapshots the fully resolved configuration, every assistant message the trajectory records names the model that produced it, and the certificate manifest records exact invocations.

## Build system

The `Makefile` is the entry point and owns nothing else: it names targets and delegates. One component, one pair of targets, so `make llops` builds llops and `make test-llops` tests it, and a component added later brings its own pair. `make test` runs every suite, `make check` runs every hook over every file, and `make help` lists the lot.

- `llops/`: CMake with `find_package(LLVM)`. `make llops` configures into `<toolchain>/llops/build` against the toolchain's LLVM and builds there, so which LLVM a binary belongs to is visible from where it sits.
- `engine/`: bun throughout: `bun install`, `bun run`, `bun test`. Bun runs TypeScript directly, so there is no build step and `make engine` is the typecheck, `tsc --noEmit`.
- `scripts/`: plain Python, standard library only at runtime. The environment uv builds is for the dev tools, not for these.

`TOOLCHAIN` is the one location knob: `JOBS=` sets build parallelism and `BUILD_TYPE=Debug` switches the llops build, and that is the whole list. `make clean` removes the llops build tree. No target removes a toolchain.

### Checks and git hooks

The checks are not ours. [pre-commit](https://pre-commit.com) runs them, and `.pre-commit-config.yaml` is the one place that says which upstream tool checks what, each pinned to a revision that `pre-commit autoupdate` bumps in a reviewed diff: clang-format for C++, biome for TypeScript and JSON, ruff for Python, shellcheck and shfmt for shell, whitespace and syntax hooks for the rest, and gitlint for commit messages against the rules in [CLAUDE.md](../CLAUDE.md), with `.gitlint` holding the settings. The clang-format is the one that ships with the LLVM version we pin, so the formatter and the compiler agree.

The hooks are part of the dev environment, so `make deps-dev` provisions both: the tools, from `uv.lock`, and the hooks in this clone. A hook that rewrites a file fails the commit with the fix already applied, so the loop is review, stage, commit again. The hooks see staged files only; `make check` is the same set over the whole tree, which is what CI runs.

### Dependencies

### The toolchain

llops, alive-tv and llubi are built from source, from the pins in `scripts/depman.sh`, against one LLVM. Mixing builds is unsupported: the three agree on what a module means only when they share an LLVM, and a system LLVM or a packaged alive2 is not a configuration any target produces.

A toolchain is one directory holding that build, and one can serve several checkouts. Its layout is a contract between `scripts/depman.sh`, which builds into it, and `engine/core/toolchain.ts`, which reads from it:

```
<toolchain>/llvm-project/build/bin/llvm-config
<toolchain>/alive2/build/alive-tv
<toolchain>/llubi-legacy/build/llubi
<toolchain>/llops/build/llops
<toolchain>/toolchain.json      what was built, from which revisions
```

Where that directory is has one answer: the `TOOLCHAIN` environment variable, then `toolchain` in `config.jsonc`, then `deps/` in the repository. `scripts/depman.sh toolchain` prints it, and the Makefile, the agent and `llops/test/llops_test.py` ask rather than resolving it again.

A run reads the toolchain before it proves anything: it asks each binary which LLVM it carries and stops if they disagree or one is missing. What it found, with `toolchain.json`, goes into `run_start`.

### Dependencies

`scripts/depman.sh` owns the toolchain, and the host tools beside it: bun with the JS packages, and uv with the Python ones. The host tools are not part of the toolchain and are installed where their own installers put them; a machine that already has one keeps it. `make install-deps` builds what is missing and then llops; `make deps-status` reports what is there; a single dependency is `make deps-llvm`, `make deps-alive2` and so on, and `FORCE=1` rebuilds one that is already present.

What counts as missing is one check per dependency, so a build that already fits is left alone. For LLVM it is an `llvm-config` in the toolchain reporting the pinned release, with RTTI, which alive2 needs. For alive2 and llubi it is the binary being there and reporting that same release. For the Python packages it is `uv sync --check`, which compares the environment against `uv.lock` the way `bun.lock` pins the JS side, and for the dev environment the same plus the git hooks being in place. Prerequisites we do not install (git, cmake, ninja, curl, a C++ compiler, and the Z3 development headers alive2 needs) are reported with the command that installs them.

Four details are worth knowing before changing that script:

- The pins live at the top of it. Moving the LLVM pin means rebuilding alive2, llubi and llops against it.
- LLVM is built with shared libraries, RTTI, assertions and `LLVM_ABI_BREAKING_CHECKS=WITH_ASSERTS`, and with lld where the machine has it. alive2 does not configure without RTTI. `LLVM_TARGETS` and `LLVM_PROJECTS` widen the build, which is X86 and llvm alone by default.
- llubi is the out-of-tree interpreter at dtcxzyw/llvm-ub-aware-interpreter, not the rewrite in `llvm/tools`.
- alive2 builds `alive-tv` only with `-DBUILD_LLVM_UTILS=1`.
- uv provides the Python interpreter as well as the packages, so a machine needs no system Python for `make deps-py`. It is still needed for the stdlib-only scripts, `check.py` above all, which run under whatever `python3` a consumer has.
- `py` and `dev` share one environment: `py` installs what a run needs, `dev` adds what a contributor needs. Both sync with `--inexact`, so installing either never removes what the other put there.

The LLVM build is the expensive one, roughly an hour and tens of gigabytes. Everything else is minutes, and llops is seconds.

## Testing

- llops: `llops/test/llops_test.py` drives the binary over its JSON protocol, which is the interface under test; see [llops.md](./llops.md).
- Agent: bun test for state, drivers (against stub binaries), and tool semantics; goal tree derivation replayed from recorded trajectories.
- Scripts: standard library unittest, run by `make test-scripts`.
- check.py: `scripts/check_test.py`, run by `make test-scripts` with the visualizer's. Golden packages that must pass and bent ones that must fail; the second half is the one that matters.
- examples: `engine/examples/` holds a pair and the script that settles it, one file per scenario, with the verdict it claims when that is not `verified`. The example list lives there with them, and `engine/core/prove.ts` runs one; `bun test` runs each at `engine/test/examples.test.ts` against the toolchain, and each that ends verified a second time against a checker that agrees with everything, which needs no solver installed and tests only which moves the framework makes. `make examples` runs them into `sessions/`, which is what the visualizer and the certificate checker read.

## Implementation order

1. llops: validate, canon, edit ops, outline, inline, analyze; tests.
2. The llops driver, then the state layer it feeds: store, trajectory, goal tree derivation.
3. visualize.py against recorded trajectories.
4. The alive-tv and llubi drivers; config plumbing.
5. Steps, transactions, splits, and the strengthen flow over the facts analyze proposes, against a stub alive-tv.
6. Tools wired into Pi; the scripted driver running through the tool layer.
7. Certificate assembly and check.py, with the tamper test suite.
8. Real-agent e2e on growing program sizes.
