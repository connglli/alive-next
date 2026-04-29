# Alive-Next pilot plan: decomposition

A staged plan to build a working pilot of the **compositional verification** mechanism described in [`IDEA.md`](IDEA.md). The pilot lives **inside the cloned alive2 tree** at `buildbench/alive-next/`, in a new self-contained subdirectory `alive-next/tv-next/`. It links directly against alive2's source-level APIs — no subprocess spawning, no parsing of alive-tv's textual output. We reuse rather than reimplement IR loading, SMT initialization, and the per-pair refinement checker; the pilot adds the diff / cut / catalog / assume / compose machinery on top.

> Companion: [`IDEA.md`](IDEA.md) — the design rationale and the four sub-cases of the compositional frame this plan operationalizes.

---

## Goal

**Verify all six worked examples from `alive-next.md`.** Each example exercises a distinct sub-case of the compositional frame; success on all six demonstrates the pilot covers the full structural progression.

The exit criterion for the pilot is binary: every example verifies. Performance targets and corpus-wide recovery rates come *after* the pilot proves itself on the curated set.

---

## The test set

| # | Example | In `alive-next.md`? | Source | Mechanism(s) needed |
|---|---------|---------------------|--------|---------------------|
| 1 | Example 1 — single-instr catalog dispatch | yes | corpus | diff + per-line cut + per-cut alive2 |
| 2 | Example 1' — variant of Example 1 with `ptrtoint` and add-commutativity | no, see below | corpus | (same as 1, plus `add-comm` catalog entry) |
| 3 | Example 2 — multi-instr catalog dispatch | yes | corpus | + multi-line diff grouping + multi-line cut |
| 4 | Variant B — multi-instr + strength reduction + flag relaxation | yes | corpus | + richer multi-line catalog templates |
| 5 | Variant A — flag-addition with range-from-sext assume | yes | corpus | + assume articulation + per-assume verifier |
| 6 | Example 4 — purely scalar assume-needed (freeze drop) | yes | synthetic | (covered by Variant A's mechanism set) |
| 7 | Example 3 — vectorization + per-lane lifting + poison-flow assume | yes | corpus | + multi-side cut + per-lane lifting + assume |

**Cumulative additions** as we move down the table — each row needs everything above it plus the right-hand column. The phasing below follows this order.

**Sources of assumes in the pilot.** For this plan, assumes are **hand-written** — we provide them as input alongside `pre.ll` / `post.ll`. The pilot's job is to *verify* and *use* the assumes, not to generate them. LLM-generated assumes are a separate later project that plugs into the same input slot.

### Example 1' — IR (not in `alive-next.md`)

This variant came up in conversation alongside Example 1 but was not formally written up; it's nearly isomorphic to Example 1, adding only `add` commutativity (a sibling of `mul` commutativity) and a `ptrtoint` that's identity-preserved between pre and post. Including it in the test set ensures the catalog covers `add-comm` and that identity-preservation across non-arithmetic casts works.

**Pre-opt:**

```llvm
define i64 @src(ptr %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) #0 {
entry:
  %v0 = ptrtoint ptr %p0 to i64
  %v1 = sub i64 %p1, %v0
  %v2 = sdiv exact i64 %v1, 8
  %v3 = sub nsw i64 %v2, %p2
  %v4 = mul nsw i64 %p3, %v3
  %v5 = sub i64 %p4, %p5
  %v6 = sdiv exact i64 %v5, 16
  %v7 = add nsw i64 %v4, %v6
  ret i64 %v7
}
```

**Post-opt:**

```llvm
define i64 @tgt(ptr %p0, i64 %p1, i64 %p2, i64 %p3, i64 %p4, i64 %p5) #0 {
entry:
  %v0 = ptrtoint ptr %p0 to i64
  %v1 = sub i64 %p1, %v0
  %v2 = ashr exact i64 %v1, 3
  %v3 = sub nsw i64 %v2, %p2
  %v4 = mul nsw i64 %v3, %p3
  %v5 = sub i64 %p4, %p5
  %v6 = ashr exact i64 %v5, 4
  %v7 = add nsw i64 %v6, %v4
  ret i64 %v7
}
```

**Diffs.**

| pos | pre-opt | post-opt | rewrite kind |
|-----|---------|----------|--------------|
| v2 | `sdiv exact i64 %v1, 8`  | `ashr exact i64 %v1, 3` | catalog L1 (sdiv-exact-pow2 → ashr-exact) |
| v4 | `mul nsw i64 %p3, %v3` | `mul nsw i64 %v3, %p3` | catalog L3 (mul-comm) |
| v6 | `sdiv exact i64 %v5, 16` | `ashr exact i64 %v5, 4` | catalog L2 (sdiv-exact-pow2 → ashr-exact) |
| v7 | `add nsw i64 %v4, %v6` | `add nsw i64 %v6, %v4` | catalog **add-comm** (new entry, sibling of mul-comm) |

The `ptrtoint` at v0 is identical on both sides — handled by the composer's identity check, no cut needed.

---

## Architecture (final, end of pilot)

```
[pre.ll, post.ll]   or   [combined.srctgt.ll]
       │
       ▼
   LLVM IR parsing                  (LLVM C++ API)
       │
       ▼
   llvm2alive (alive2's API)        → IR::Function for src and tgt
       │
       ▼
   Diff + cut planner               (per-line, multi-line, multi-side;
       │                             Phase 4: per-lane lifting of vector ops)
       │
       ├──► Catalog matcher           (structural pattern match against the
       │                              bundled catalog of pre-verified rewrite
       │                              templates; AST unification on opcodes,
       │                              flag sets, operand metavariables; fast,
       │                              no SMT, no LLM. Hit → cached verdict.)
       │
       ├──► On catalog miss / unsatisfied precondition:
       │      Assume proposer        (Phase 3+ hand-coded heuristics:
       │      ├── hand-coded          range-from-mask, no-overflow-from-sext;
       │      └── LLM (--model …)     LLM fallback for what hand-coded
       │                              proposers don't cover. Both produce a
       │                              candidate `cond`.)
       │           │
       │           ▼
       │      Assume verifier        (build a small Transform asking
       │                              "does `cond` hold here given the
       │                              function entry?" — TransformVerify::verify.)
       │           │
       │◄──────────┘
       ▼
   Cut dispatcher                   (catalog hit → cached verdict; otherwise
       │                             build a small Transform from the cut,
       │                             with `llvm.assume(cond)` injected for any
       │                             verified assumes, call TransformVerify::verify.)
       ▼
   Composition checker              (operand-chain consistency + assume-scoping
       │                             propagation + identity-position strict
       │                             match. Refinement is transitive given these
       │                             checks; no whole-function re-run by default.)
       ▼
   Verdict
```

Per-cut verification is **a single in-process call** to alive2's `TransformVerify::verify()` — no subprocess, no IR re-parsing per cut. The pilot's binary links against alive2's libraries directly.

The architecture grows phase by phase. Phase 1 has only the single-instr cut path, no assumes, no LLM, no catalog. Each subsequent phase activates one more box.

The **catalog** is internal infrastructure: bundled with the build, located at a compiled-in path under the install prefix. Not user-facing; no `--catalog` flag in the user CLI. (A `--catalog-override DIR` developer flag is available for catalog testing — see "CLI" below.) **LLM access** is opt-in via `--model MODEL` and the `ALIVE_NEXT_LLM_*` env vars; without them, the pilot uses only the catalog and hand-coded proposers and falls back to per-cut alive2 on the leftover.

---

## Phase 1 — single-instr catalog dispatch (Examples 1 and 1')

**Targets:** Example 1, Example 1'.

### What it needs

- A new CMake target `alive-tv-next` inside `alive-next/tv-next/` that links alive2's `ir`, `smt`, `llvm_util`, and `tools` libraries.
- `main.cpp` scaffolding modeled on `tools/alive-tv.cpp` (LLVM init, `smt_initializer`, `.ll` parsing).
- `ir_load`: parse a `.ll` file (single file with `@src`+`@tgt`, or two `.ll` files), call `llvm_util::llvm2alive` on each function to get `IR::Function`s.
- `diff`: pair-walk pre and post, tag each position as identical or differing. Phase 1 requires equal instruction count.
- `cut` (single-instr): for each diff position, build a small `tools::Transform` whose `src` and `tgt` each contain one instruction with its operands lifted to function parameters and the result returned.
- `verify`: call `TransformVerify::verify()` per cut; on `Errors::isUnsound() == false`, the cut passes.
- `compose`: identity-compare unchanged positions (textual match modulo metadata + SSA renaming); ensure operand-dependency chain is consistent across cuts. `ptrtoint` and other casts that appear identically on both sides hit the identity path, no cut needed.

### Deliverables

| ID | Deliverable | Effort |
|----|-------------|--------|
| M1.1 | CMake target + `main.cpp` scaffolding + `ir_load`; loads a paired `.ll` test file end-to-end | ~1 day |
| M1.2 | `diff` + single-instr `cut` + `verify` (per-cut `TransformVerify::verify`) | ~2 days |
| M1.3 | `compose` (identity comparison + dependency-chain check); end-to-end CLI returns a verdict | ~1 day |
| M1.4 | **Example 1 verifies end-to-end** | day-of validation |
| M1.5 | **Example 1' verifies end-to-end** (same mechanism, exercises `add` commutativity and `ptrtoint` identity path) | day-of validation |

**Phase 1 exits when Examples 1 and 1' both verify.** No more, no less.

Source-level integration cuts the engineering load — there's no IR re-parsing per cut, no subprocess management, no alive-tv stdout parsing. Phase 1 is mostly diff / cut / compose plumbing on top of alive2's existing APIs.

---

## Phase 2 — multi-line catalog dispatch (Example 2 + Variant B)

**Targets:** Example 2, Variant B.

### What it adds

- **Multi-line diff grouping.** Detect adjacent diff positions where post-side operand chains cross diff boundaries (e.g., post-`v4` reads post-`v3`, but pre-`v4` reads pre-`v3` of a different opcode → group `v3` and `v4` into one cut).
- **Multi-line cut builder.** Lift a group into a function with multiple instructions, parameters for external operands, return value at the group's exit.
- **Catalog (first time).** A small catalog of pre-verified rewrite templates, both single- and multi-line. Initial entries from the test set:
  - `sdiv-exact-pow2-to-ashr-exact` (parameterized over k).
  - `mul-pow2-to-shl-with-flags` (parameterized over k and flag set).
  - `add-comm`, `mul-comm`, etc. (commutativity, with flag variants).
  - `sub-zext-to-add-sext` (Example 2's L4).
  - `(p+1)*c-to-shl+add` (Variant B's L_v0v1).
- **Catalog matcher.** Opcode + flag + operand-consistency match against catalog templates. Match → dispatch to cached verdict; miss → fall back to per-cut alive2.
- **Catalog verifier.** Run alive2 once per catalog template at build time; cache the verdict in `proof.json`.

### Deliverables

| ID | Deliverable | Effort |
|----|-------------|--------|
| M2.1 | Multi-line diff grouping logic + multi-line cut builder | ~3 days |
| M2.2 | Catalog format + verifier; populate with the entries above | ~2 days |
| M2.3 | Pattern matcher (single + multi-line) | ~3 days |
| M2.4 | **Example 2 and Variant B verify end-to-end** | day-of validation |

**Phase 2 exits when Examples 1, 2, and Variant B all verify.**

---

## Phase 3 — assume mechanism (Variant A + Example 4)

**Targets:** Variant A, Example 4.

The pilot's input remains a raw slice (`pre.ll` / `post.ll` or `combined.srctgt.ll`) — assumes are **not** part of the input. `alive-tv-next` derives them itself.

### What it adds

- **Assume proposer (hand-coded heuristics).** For cuts whose catalog entry has an unsatisfied precondition, walk the slice's local IR to derive a candidate assume. The Phase 3 proposer covers two derivation patterns drawn from the test set:
  - **range-from-mask** — when an operand needs a bound, look upstream for an `and`-mask that constrains it. Emits `icmp ult/ule` on the masked value.
  - **no-overflow-from-sext** — when a `mul nsw` is being added, look upstream for `sext` operands that bound the product. Emits a `llvm.smul.with.overflow.i64` + extracted-bit check.
  These are hand-coded matchers tied to specific rewrite shapes; an LLM-driven generic proposer is a follow-on project.
- **Assume verifier.** For each proposed `cond`, build a small alive2 query of the form "given the slice's entry state, prove `cond` holds at the proposal's program point." Cheap; alive2 dispatches in milliseconds for the proposers above.
- **Cut dispatch under assume.** When verifying a cut whose catalog entry needs a precondition, the cut builder injects `llvm.assume(cond)` into the `IR::Function` it constructs from the cut, then calls `TransformVerify::verify`. Alive2 picks up the assume automatically as a constraint.
- **Catalog entries with preconditions.** Some catalog templates (e.g., `freeze-drop-on-non-poison`, `add-nsw-on-no-overflow`) declare a precondition schema. The matcher checks opcode/operand match AND triggers the proposer to emit a candidate satisfying the schema.

### Concrete proposers / assumes for the test set

- **Variant A — `A2`:** "the `mul i64 %v0, %v1` does not signed-overflow" — emitted by the no-overflow-from-sext proposer when both `%v0` and `%v1` are seen as `sext i32 → i64`.
- **Example 4 — `A1`:** "%v0 < 64" — emitted by the range-from-mask proposer when `%v0 = and i64 %p0, 31` is upstream of a `shl` whose poison condition is bitwidth-bound.

### Deliverables

| ID | Deliverable | Effort |
|----|-------------|--------|
| M3.1 | Catalog entries with preconditions: `freeze-drop-on-non-poison`, `add-nsw-on-no-overflow` | ~2 days |
| M3.2 | Hand-coded assume proposers: range-from-mask, no-overflow-from-sext | ~3 days |
| M3.3 | Assume verifier (per-assume alive2 query) + injection of `llvm.assume` into cut builders | ~2 days |
| M3.4 | **Variant A and Example 4 verify end-to-end** | day-of validation |

**Phase 3 exits when Examples 1, 2, 4, and Variants A and B all verify.**

---

## Phase 4 — multi-side + per-lane lifting (Example 3)

**Targets:** Example 3.

### What it adds

- **Multi-side diff.** Detect cases where the pre-side and post-side have different instruction counts in the changed region. Tag the entire region as one "multi-side cut" rather than trying to align positions.
- **Per-lane lifting.** Recognize a vector-op group (post-side of Example 3) and decompose it into N per-lane scalar equivalence problems. Requires:
  - A list of vector-op decomposition axioms (`L_vec` from Example 3) — one per opcode kind, hand-written and verified once.
  - Logic to walk the insertelement / vector-op / extractelement chain and produce per-lane scalar IR.
- **Poison-flow assume.** Example 3's `A_lane0` (lane 0 of `<poison, 0>` is overwritten before any read) — articulated as a Phase 3-style assume on the insertelement chain.
- **Multi-side cut dispatch.** Match a multi-side cut against catalog "vectorization templates" — entries that say "N scalar instructions on the LHS ≡ M vector instructions on the RHS, modulo per-lane lifting."

### Deliverables

| ID | Deliverable | Effort |
|----|-------------|--------|
| M4.1 | Multi-side diff detection + region tagging | ~2 days |
| M4.2 | Per-lane lifting infrastructure: walk insert/extract chains, produce per-lane scalar problems | ~4 days |
| M4.3 | Vector-op decomposition axioms (`L_vec`) for the opcodes used in Example 3 (`sub`, `sdiv exact`) | ~1 day |
| M4.4 | Catalog entry for the SLP vectorization template | ~2 days |
| M4.5 | **Example 3 verifies end-to-end** | day-of validation |

**Phase 4 exits when all six examples verify.** That's the pilot's goal.

---

## File layout (target end of Phase 4)

The pilot's code, catalog, and tests all live under one new subdirectory inside the cloned alive2 tree. Existing alive2 files are not modified except for one line in the top-level `CMakeLists.txt` to register the new subdirectory.

```
buildbench/
  extract.cpp                # existing
  optimize.sh                # existing
  alive-next/                # cloned alive2 source (existing, untouched
                             #   except for CMakeLists.txt one-line addition)
    CMakeLists.txt           # add_subdirectory(tv-next) added here
    ir/, smt/, llvm_util/,
    tools/, tv/, ...         # existing alive2 sources
    tv-next/                 # NEW — pilot's everything (flat layout, alive2 style)
      CMakeLists.txt
      main.cpp               # CLI entry point
      ir_load.{h,cpp}        # LLVM .ll loading + llvm2alive invocation
      diff.{h,cpp}           # pairing + diff (per-line, multi-line, multi-side)
      cut.{h,cpp}            # cut lifting → small IR::Function pairs
      lift_lane.{h,cpp}      # per-lane lifting for vector cuts (Phase 4)
      match.{h,cpp}          # catalog pattern matching (Phase 2)
      assume.{h,cpp}         # hand-coded assume proposers + per-assume verifier
                             #   + llvm.assume injection into cut builders (Phase 3)
      verify.{h,cpp}         # per-cut dispatch via TransformVerify::verify
      compose.{h,cpp}        # composition checker
      verify_catalog.cpp     # one-time catalog verifier (separate target)
      catalog/               # source-of-truth for the bundled catalog;
                             #   compiled-in path or installed alongside the
                             #   binary. Not user-facing — no --catalog flag.
        sdiv-exact-pow2-to-ashr-exact/
          pattern.ll         # in @src/@tgt format with metavariables
          replacement.ll
          meta.json          # parameters, flag variants
          proof.json         # cached alive2 verdict (populated by
                             #   verify-catalog; checked into source after a
                             #   verify-catalog run, so end users don't
                             #   re-verify on every build)
        mul-comm/ ...
        add-comm/ ...
        sub-zext-to-add-sext/ ...   # Phase 2 multi-line entry
        add-nsw-on-no-overflow/     # Phase 3 entry — has precondition
          pattern.ll
          replacement.ll
          precondition.smt   # required assume schema
          proof.json
        slp-vec-2x-sdiv/ ...        # Phase 4 vectorization template
      README.md              # status / pointers back to PLAN.md and IDEA.md
    tests/                   # alive2's existing test tree
      alive-tv/, ...         # upstream tests, untouched
      alive-tv-next/         # NEW — alive-next's reference tests (already populated)
        e1.srctgt.ll
        e1alt.srctgt.ll
        e2.srctgt.ll
        e3.srctgt.ll
        e4.srctgt.ll         # raw slice; alive-tv-next derives the assume internally
        varA.srctgt.ll
        varB.srctgt.ll
        README.md
```

Build targets (added to alive2's existing build):

- `alive-tv-next` — the main pilot binary; links against alive2's `ir`, `smt`, `llvm_util`, `tools` libraries.
- `verify-catalog` — separate binary, run once per catalog change to populate `proof.json` files. Not part of the end-user installation; lives only in the build tree.

Catalog packaging: at install time, `tv-next/catalog/` is copied to `${install_prefix}/share/alive-tv-next/catalog/`. The binary locates it via a compiled-in default path; a developer-only `--catalog-override DIR` flag exists for testing alternate catalogs but is not part of the documented user CLI.

### CLI

The user-facing surface is small:

```
alive-tv-next [alive-tv flags...] [--model MODEL] pre.ll [post.ll]
alive-tv-next [alive-tv flags...] [--model MODEL] combined.srctgt.ll
```

`pre.ll` and `post.ll` can also be a single `.ll` file in `@src` / `@tgt` form (alive-tv's format); the loader detects which is given.

#### Inherited alive-tv flags

`alive-tv-next` inherits **all** of `alive-tv`'s flags by including the same `llvm_util/cmd_args_list.h` header that `tools/alive-tv.cpp` does:

```cpp
#define LLVM_ARGS_PREFIX ""
#define ARGS_SRC_TGT
#define ARGS_REFINEMENT
#include "llvm_util/cmd_args_list.h"
```

That pulls in `--smt-to`, `--disable-undef-input`, `--disable-poison-input`, `--src-fn`, `--tgt-fn`, the LLVM init flags, etc. No duplication; alive-tv flag additions land for free in `alive-tv-next` whenever the upstream header changes.

#### `alive-tv-next`-specific flags

| Flag | Purpose | Phase |
|------|---------|-------|
| `--model MODEL` | LLM model name for cut/assume proposers when LLM fallback is enabled. Without it, the pilot uses only the catalog and hand-coded proposers and falls back to per-cut alive2 on the leftover. | Later (post-pilot) |

#### Developer flags (not documented for end users)

| Flag | Purpose |
|------|---------|
| `--no-catalog` | Skip catalog matching; force every cut through alive2 directly. For benchmarking the catalog's value. |
| `--no-llm` | Force-disable the LLM proposer even if `--model` is given. Useful for reproducibility. |
| `--catalog-override DIR` | Use a custom catalog directory instead of the bundled one. For catalog development / A-B testing. |
| `--whole-function-recheck` | After composition succeeds, also run alive2's whole-function refinement check with all verified assumes injected as `llvm.assume` — paranoid double-check. Off by default. |
| `--dump-cuts DIR` | Serialize each generated cut to `<DIR>/<id>.srctgt.ll`. For inspection / debugging. |

#### Environment variables

| Variable | Used for | Required? |
|----------|----------|-----------|
| `ALIVE_NEXT_LLM_API_KEY` | Auth token for the LLM provider | Yes, when `--model` is set |
| `ALIVE_NEXT_LLM_BASE_URL` | API endpoint (default: provider's public endpoint) | Optional |

`--model` is intentionally a flag, not an env var — it's a per-invocation choice users will A/B-test, not a deployment-fixed value like the endpoint or the API key.

---

## Reuse from existing code

### From alive2 (linked directly inside `alive-next/tv-next/`)

| Symbol / file | Provides | Used in |
|---------------|----------|---------|
| `llvm_util::llvm2alive(F, TLI, IsSrc)` | LLVM `Function` → `IR::Function` (alive2's IR) | `ir_load.cpp` |
| `tools::Transform` | src/tgt pair + optional precondition | `cut.cpp`, `assume.cpp` |
| `tools::TransformVerify::verify()` | run a refinement check, return `util::Errors` | `verify.cpp`, `assume.cpp` |
| `IR::Predicate` | first-class precondition object | `assume.cpp` |
| `smt::smt_initializer` | SMT context lifecycle | `main.cpp` |
| `llvm_util::Verifier` | high-level reference path used by `alive-tv.cpp` | `main.cpp` (model only) |

`tools/alive-tv.cpp` is the closest reference — `alive-tv-next` follows the same `main()` scaffolding (LLVM init, `smt_initializer`, parse `.ll`, iterate functions) but invokes the diff / cut / verify pipeline instead of a single whole-function `compareFunctions`.

### From `extract.cpp` (in the parent `buildbench/` directory)

Some IR-walking helpers in `extract.cpp` (per-BB iteration, `isExcludedInst`, the type-printer) might be portable into the pilot's `ir_load.cpp` if useful. We'll reuse on a case-by-case basis rather than as a hard dependency — the pilot's IR-loading needs are simpler than `extract.cpp`'s slicing pipeline.

---

## Open questions / risks

1. **Lifting fidelity.** Per-cut lifting must preserve operand semantics. If pre[i]'s operand is poison upstream, the lifted cut shouldn't claim non-poison. Default: lift each operand as `freeze`-wrapped (conservative). Some catalog rewrites may then fail to apply because they need non-poison operands; revisit per-test-case in Phase 1–2.

2. **Identity-comparison granularity.** "Identical" = textual match modulo metadata stripping, modulo ID-renumbering. Stricter is safer; can loosen later if false-fail rate is high.

3. **Composition soundness.** Refinement is transitive — composition is sound *given* three load-bearing checks the composer must enforce:

   1. **Operand-chain consistency.** Per-cut verification of cut B was done over a particular operand binding. The composer must verify the actual `@tgt` wires post-A's output into post-B's input on the relevant edge — i.e., the SSA dependency between cuts in `@tgt` matches the dependency assumed at verification time. Structural check (compare SSA names + types modulo renaming); cheap but soundness-critical.
   2. **Assume-scoping propagation.** If cut A was verified under assume P, every later cut whose program point dominates A and whose verification implicitly relies on P's value space must also have P available. The composer propagates verified assumes through the SSA dependency graph along with their valid program-point ranges.
   3. **Identity-position strict match.** Positions classified as "unchanged" must match strictly (textual + metadata + SSA-renaming canonical), not just have the same opcode + flags. Subtle drifts here can be silent soundness bugs.

   Given these three checks, **no whole-function alive2 re-run is needed** — re-running would defeat the decomposition's whole point (it'd re-pay the SMT cost on the function we just decomposed). A `--whole-function-recheck` debug flag is offered for opt-in paranoia. Soundness rests on the composer; design carefully and document the invariant.

4. **Hand-coded proposer coverage.** Phase 3's two proposers (range-from-mask, no-overflow-from-sext) are tied to specific rewrite shapes drawn from the test set. New rewrites in later corpora may need new proposers. Resist generalizing until a real case forces it; the LLM-driven generic proposer is the eventual answer for the long tail. Assumes themselves are expressed via `llvm.assume(i1)` — LLVM's standard intrinsic, no project-specific DSL needed.

5. **Per-lane lifting completeness.** Phase 4 needs vector-op decomposition axioms per opcode. Example 3 uses `sub` and `sdiv exact` on `<2 x i64>`; other opcodes (mul, add, fp variants) come later if/when other vectorized examples appear. The Phase 4 deliverable is the *infrastructure* + the two opcodes Example 3 needs, not a complete library.

6. **Alive2 wall-clock per cut.** Per-cut alive2 has nontrivial startup cost (process spawn, IR re-parse). For Phase 1 with one alive2 invocation per diff position, slices with many diffs are slow. Phase 2's catalog cache mostly resolves this; Phase 1 numbers will look pessimistic. Acceptable for the goal (which is correctness, not speed).

---

## What "actionable" means

The plan is actionable when:

- ✓ The test set is fixed (the six examples).
- ✓ Each example is mapped to its required mechanism set.
- ✓ Phases are ordered by cumulative complexity, each ending in a concrete verification milestone.
- ✓ The CLI shape, file layout, and build system are decided.
- ✓ Reuse from existing code is identified.
- ✓ Risks are surfaced and mitigations sketched.

When this plan is signed off, next step: create `alive2/` and start on M1.1 (IR loader + diff + single-instr cut builder, validated against Example 1).
