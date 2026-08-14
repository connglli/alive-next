# alive-next

Agent-driven, alive2-certified translation validation for large LLVM IR programs.

## Project Overview

`engine/core` builds an **interactive translation validation framework**, analogous to interactive theorem proving (ITP). In this framework, a proof writer (an autonomous AI agent or a scripted proof scenario) searches for a refinement proof under interactive tactics and goal transformations, while the framework acts as a sound proof kernel that verifies each step with respect to LLVM operational semantics and emits an independent, replayable certificate.

Standard [alive2](https://github.com/AliveToolkit/alive2) validates whether a target function refines a source function by encoding the entire translation problem into a single, monolithic SMT query. While sound and complete for small functions, single-query SMT becomes intractable as programs grow. alive-next keeps alive2 as the trusted formal checker and structures translation validation as an interactive proof search:

* **Decomposition:** Proof writers cut large programs into modular components via outlining, reducing whole-program obligations to compositionally verifiable subgoals.
* **Hoare-Style Reasoning:** Cut boundaries and windowed steps establish interfaces with explicit preconditions and postconditions (e.g. `noundef`, alignment, range constraints, known bits), formally proved at the call site before being assumed in callees.
* **Refinement Rewriting:** Proof writers close semantic distances by applying chains of small, local, semantics-preserving transformations along the transitive refinement order.

### Core Invariant: Proof Writer Proposes, Framework Certifies

The agent/proof-writer is entirely untrusted. It explores search strategies: where to cut a function, which rewrites or simplifications to apply, which interface facts to assert, and which inputs to test for counterexamples. The framework strictly enforces the correctness of each decomposition step, subproof, and rewrite with respect to LLVM's operational semantics:

* **Rewrite steps** are validated by `alive2` (or verified pre-proved rewrite rules).
* **Decomposition and interface facts** are validated by `alive2` through faithful outlining and certified call-site assertions.
* **Counterexamples** are validated by concrete execution replay under the UB-aware interpreter `llubi`.

A flawed proposal wastes search budget, but can never compromise soundness or yield an incorrect certificate. A run concludes in one of three terminal outcomes: **verified** (with a standalone certificate package replayable without an agent), **refuted** (with a concrete input demonstrating divergence or undefined behavior), or **unknown** (when budgets expire or search exhausts without proof).

### Conceptual Model

* **Program Store:** Content-addressed, immutable LLVM IR modules stored by SHA-256 (`store/<sha256>.ll`). Every transformation produces a fresh module ID (`p1`, `p2`, ...); programs are never mutated in place.
* **Goal Tree:** Proof obligations represented as `(src, tgt)` pairs asserting that `tgt` refines `src`. The root goal is the input pair `(LHS, RHS)`. The goal tree settles when all leaves are discharged or the root is refuted.
* **Steps and Validation Direction:** A transformation on the `src` side moves forward (proving $S' \sqsubseteq S$), while a transformation on the `tgt` side moves backward (proving $T \sqsubseteq T'$). Both preserve transitivity toward $T \sqsubseteq S$.
* **Transactions and Window Narrowing:** Edits occur inside transactions. On commit, the framework isolates the edited instruction window into small outlined subfunctions and validates the narrowed window with `alive2`, falling back to whole-function validation only if needed.
* **Decomposition via Outlining:** Large functions are cut by outlining a suffix into a fresh shared callee `g`. This yields two smaller goals: an outer goal with an uninterpreted call to `g` (preserving cut-point state and memory refinement), and a callee goal for `g`'s body.
* **Interface Strengthening:** Callee input preconditions (such as `noundef`, alignment, and known bits) are first proved at the call site in the outer caller before being assumed on callee parameters.
* **Scope (v1):** Straightline LLVM IR functions (single basic block ending in `ret`), covering all alive2-supported operations (integer/float arithmetic, bit manipulations, vector operations, memory loads/stores, and function calls).

### System Architecture and Language Split

* **Engine (`engine/`):** Written in TypeScript and executed with [Bun](https://bun.sh). Manages the stateful proof infrastructure: the goal tree, program store, transactions, toolchain drivers, session lifecycle, and certificate generation. Hosts the agent harness built on the [Pi framework](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`).
* **Native Toolbox (`llops/`):** Stateless C++ binary linked against LLVM. Communicates via JSON over standard I/O to perform IR validation, canonical printing, analysis, outlining, inlining, concrete test harness synthesis, flags editing, and LLVM simplification.
* **External Checkers:** Pinned revisions of `alive-tv` (SMT refinement checker) and `llubi` (UB-aware interpreter) compiled from source against the toolchain's LLVM.
* **Verification and Visualization Scripts (`scripts/`):** Standalone Python standard-library scripts. `scripts/check.py` independently replays and validates certificate packages. `scripts/visualize.py` renders an interactive, self-contained HTML page of the execution trajectory.

### Common Workflows

```bash
# Build and Dependencies
make install-deps                         # Build pinned LLVM, alive2, llubi, and llops
make deps-status                          # Inspect toolchain and host dependency status

# Running the Agent
cd engine && bun run agent a.ll b.ll      # Run interactive Pi agent on an IR pair
cd engine && bun run agent --pause a.ll b.ll # Open agent paused to configure model/settings

# Scenarios and Verification
make examples                             # Run the worked tutorial scenarios into sessions/
python3 scripts/check.py sessions/<id>/certificate  # Independently replay certificate
python3 scripts/visualize.py sessions/<id> # Generate interactive session.html visualization

# Testing and Code Quality
make test                                 # Run all test suites (llops, engine, scripts)
make test-llops                           # Run llops unit tests
make test-engine                          # Run engine TypeScript tests
make test-scripts                         # Run check.py and visualize.py tests
.venv/bin/pre-commit run --all-files      # Run pre-commit hooks across the repository
```

## Principles and Best Practices

Always follow good practices:

1. Use git frequently and meaningfully
2. Follow **Conventional Commits**
3. Keep `README.md`, documents, and this file up to date
4. Fix **all compiler warnings**
5. Keep a clean, layered project structure
6. Write high-quality comments that explain *why*, not *what*
7. Comments describe the current state, not the change history, unless it is a bugfix or a workaround for a critical known issue
8. Keep functions small, shallow, and focused on a single responsibility
9. Keep CHANGELOG concise (multiple related entries can be summarized in one line)
10. Follow [./docs/AGENTS.md](./docs/AGENTS.md) when writing documents, header comments, or anything else durable in prose

Always check whether a design/implementation is *elegant*:

(1) It retains a minimalist core and a clean conceptual model.
(2) It is simple enough that an experienced developer can understand it within five minutes without any explanation.

Always keep in mind the following principles to make it elegant before designing any new feature or changing existing behavior. Consider these principles, think twice, and then design:

1. KISS: Keep It Simple, Stupid. Is this the simplest design that works?
2. SINE: Simplicity Is Not Enough. Is this design analyzable, testable, and solver-friendly?
3. DRY: Don't Repeat Yourself. Are there existing abstractions/implementations that can be reused?
4. YAGNI: You Ain't Gonna Need It. Do we really need this feature now, or is it speculative?
5. SOLID: Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion. Does this design adhere to these principles?

## Before Starting Work

1. Review recent history:

   ```bash
   git log [--oneline] [--stat] [--name-only] # Show brief/extended history
   git show [--summary] [--stat] [--name-only] <commit> # Show brief/extended history of a commit
   git diff <commit> <commit> # Compare two different commits
   git checkout <commit> # Checkout and inspect all the details of a commit
   ```
2. Understand existing design decisions before changing behavior
3. For large tasks, commit incrementally with clear messages

## Before Saving Changes

ALWAYS:

1. Clear all compiler warnings
2. Format code with `clang-format`
3. Ensure all tests pass (timeouts excepted)
4. Check changes with `git status`
5. Split work into small, reviewable commits
6. Ask the user to review your changes before committing
7. Use Conventional Commit messages:

```text
<type>[optional scope]: <title>

<body>

[optional footer]
```

* Title ≤ 50 characters
* Body explains intent and design impact

**Remember:**
alive-next prioritizes *clarity, analyzability, and solver-friendliness* over surface-level convenience.
Preserve these properties in every change.
