# The idea: compositional verification with an LLM oracle

A self-contained statement of the design rationale behind the pilot at `alive-next/tv-next/`. The companion document is [`PLAN.md`](PLAN.md), which translates this into concrete phases, milestones, and a test set.

## The problem

Alive2 verifies LLVM optimizations by encoding a refinement check as an SMT query and dispatching it to Z3. The encoding is precise and correct; what's limited is **reach**:

- **SMT scaling cliff.** Z3 doesn't degrade gracefully with formula size — it falls off a cliff. A function with three nested `sdiv` operations and a `mul`, all on i64, is enough to push it past `--smt-to=60000`. Most "alive2 timeout" verdicts in the wild are the formula being too big, not the math being unmodeled.

- **Whole-function framing.** Alive2's natural unit is `{src, tgt}` for an entire function, but its *tractable* unit is much smaller: a few instructions of nonlinear arithmetic, a chain of variable shifts, a poison-flow path with one too many forks. The mismatch between the natural and tractable units is what produces the timeouts.

- **Precision gaps at the edges of the model.** Scalable vectors, target-specific intrinsics, refined LLVM trunk semantics — these are out of model entirely. They produce `unknown` rather than `timeout`. Different cause, same result: the verifier cannot decide.

The pilot addresses the first two directly. The third (model gaps) is out of scope for this pilot but is part of the broader Alive-Next design.

## The frame

Treat verification as **compositional** rather than monolithic. Borrow the structure from Hoare logic / axiomatic semantics:

- The function is decomposed into *chunks* small enough that alive2 can decide each one cheaply.
- Each chunk is verified as a Hoare triple `{P} chunk {Q}` — entry-state precondition `P`, body `chunk`, postcondition `Q`.
- Chunks compose: if `{P} A {Q}` and `{Q} B {R}` both verify, then `{P} A;B {R}` holds without any new SMT work.
- The function-level verdict is the composition of all the chunk-level verdicts.

Two ingredients are missing from a vanilla Hoare-style approach when applied to LLVM IR:

1. **Where to cut.** Good cuts respect data-flow boundaries (so the resulting chunks have small interfaces) and align with semantic boundaries (so the postconditions are expressible). Picking cuts is a heuristic problem.

2. **What to assume at cuts.** The pre / postconditions at each cut are predicates over IR variables: `%v ∈ [0, 31]`, `%p` is non-poison, `%x ≠ 0`. These are the predicates that turn an SMT-hard chunk into an SMT-easy one. Picking them is also heuristic.

## The LLM as oracle

Both heuristic problems are exactly where LLMs are good and SMT solvers are bad. Pattern recognition, locally-true fact articulation, multi-line idiom classification — the LLM's wheelhouse.

But LLMs cannot be trusted as the final word for a verification result. So the architecture is:

> **LLM proposes; SMT disposes.**

The LLM proposes cuts and assumes; alive2 verifies each cut as a refinement check and each assume as a small standalone query. The LLM's proposals are heuristic — wrong cuts and wrong assumes both get rejected by alive2 cheaply (a small SMT query refutes the wrong guess). Soundness comes entirely from the SMT side; reach is extended entirely by the LLM side.

For this pilot, the LLM is **not in the loop yet**. Cuts are derived from structural diffs between `pre.ll` and `post.ll`; assumes are hand-written by the test-set author. The pilot proves the *infrastructure* — diff, cut, verify, assume, compose — works on a curated set of examples. LLM-driven cut and assume proposers plug into the same input slots later.

## Why this works

Three reasons compositional verification is the right shape for today's LLVM:

1. **Linear cost vs cliff cost.** Total SMT cost becomes *linear* in the number of chunks, not exponential in the function size. Each chunk is small enough that Z3 stays on the easy side of the scaling cliff.

2. **Catalog amortization.** Most of the chunks in real LLVM optimizations are instances of a small number of *catalog rewrites*: `sdiv exact x, 2ᵏ ≡ ashr exact x, k`, mul/add commutativity, `sub-of-zext ↔ add-of-sext`, etc. Verify each catalog entry once, ahead of time; thereafter the per-chunk cost is a structural match plus a cache lookup. SMT cost approaches zero per slice once the catalog covers the corpus.

3. **Local invariants suffice.** Most LLVM rewrites that look context-dependent are sound under a *locally* derivable invariant (a range from a `and`-mask, a non-poison from a `sext`, a non-zero from a dominating compare in the same BB). Once the invariant is articulated, the rewrite reduces to a catalog dispatch. The LLM's role is to spot the invariant; alive2's role is to verify it.

Three reasons it doesn't trivialize the problem:

- **Cuts must respect dependency chains.** Composition is sound only if every operand of `chunk B` was either identical to its pre-rewrite counterpart or proven equivalent at a prior chunk. A bug in the dependency-chain check is a soundness bug.

- **Lifting fidelity matters.** Lifting a single instruction into a small `Transform` requires deciding what the operands *are* — concrete external values, possibly-poison upstream values, frozen values. Wrong lifting can prove an equivalence that doesn't actually hold in the larger function context.

- **Assumes must be locally checkable.** An assume that requires global context (caller-side facts, IPO information) is out of reach. The pilot only handles assumes that are decidable from the slice's own IR.

## The four sub-cases the pilot targets

The test set in [`PLAN.md`](PLAN.md) is structured around four sub-cases of the compositional frame, in increasing complexity:

1. **Single-instruction catalog dispatch.** The structural diff is per-line; each diff is one instance of one catalog rewrite. LLM's job (in the LLM-augmented version): recognize each diff as a catalog instance, dispatch to the pre-verified lemma. Pilot's job: structural diff + catalog match + per-cut verify.

2. **Multi-instruction catalog dispatch.** Consecutive instructions change in lockstep — a single rewrite spans 2+ lines. Naive per-line diff fails to group them; the rewrite must be recognized at the *pair* (or longer) level. Catalog entries are correspondingly multi-line. Pilot's job: diff grouping + multi-line cut + multi-line catalog match.

3. **Vectorization with per-lane lifting.** Pre-side and post-side have different instruction counts (e.g., 3 scalar instrs ↔ 7 vector instrs from SLP vectorization). Per-cut verification requires lifting the vector ops into per-lane scalar problems. Adds a *poison-flow assume* on unused vector-lane initialization. Pilot's job: multi-side diff + per-lane lift infrastructure + assume integration.

4. **Scalar assume-needed.** A rewrite is sound only under a context-dependent precondition (a range, a non-poison, a non-zero). The pilot — given just the slice — derives the precondition itself: a hand-coded proposer (Phase 3) recognizes the rewrite shape, walks local IR to extract the supporting fact (e.g., a range from an `and`-mask, no-overflow from `sext` bounds), proposes the assume, verifies it standalone via alive2, and injects it as `llvm.assume` into the per-cut alive2 query so the rewrite verifies under the assume. Pilot's job: assume proposer + per-assume verifier + dispatch under assume.

Each sub-case stresses one more LLM capability than the previous: per-line classification → multi-line pattern grouping → multi-side rewrites + structural lifting + assume articulation → context-aware invariant articulation. The pilot's infrastructure grows correspondingly.

## What's in scope for the pilot

| In scope | Out of scope |
|----------|--------------|
| Diff + cut + per-cut alive2 dispatch | Subprocess-driven alive-tv invocation |
| Catalog of pre-verified rewrites | LLM that proposes catalog entries |
| Multi-line, multi-side cuts | Multi-function / inter-procedural cuts |
| Per-lane lifting for vector ops | Scalable-vector reasoning beyond per-lane |
| Hand-coded assume proposers (range-from-mask, no-overflow-from-sext, …) | LLM-driven generic assume proposer |
| Refinement check inside `IR::Function` pairs | Modifying alive2's SMT encoding or model |

The pilot's input is just the slice — `pre.ll` / `post.ll` (or a single `@src` / `@tgt` file). Assumes are not part of the input; the pilot derives them itself, using a small set of hand-coded proposers in Phase 3 that cover the test set's patterns. An LLM-driven proposer is a follow-on project that plugs into the same internal proposer interface.

The IR construct used for assume injection is LLVM's standard `llvm.assume(i1)` intrinsic — `alive-tv-next` builds a per-cut `IR::Function` with `llvm.assume` calls at the relevant program points and dispatches via `TransformVerify::verify`. No custom DSL, no external assume file.

## Connecting to the plan

[`PLAN.md`](PLAN.md) translates this idea into:

- A test set of seven concrete examples (each exercising one of the four sub-cases above).
- Four phases, each ending in a verification milestone for one or two test cases.
- A file layout under `alive-next/tv-next/` (new self-contained subdirectory) that links against alive2's source-level APIs (`llvm2alive`, `Transform`, `TransformVerify::verify`, `IR::Predicate`, `smt::smt_initializer`).
- A reuse table mapping our components to the alive2 symbols they call.

The pilot is "actionable and clear" once the plan is signed off — at that point we start on M1.1 (CMake target + `main.cpp` scaffolding modeled on `tools/alive-tv.cpp`).
