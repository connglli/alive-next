# Alive-Next pilot plan: decomposition

A staged plan to build a working pilot of the **compositional verification** mechanism described in [`IDEA.md`](IDEA.md). The pilot lives **inside the cloned alive2 tree** at `buildbench/alive-next/`, in a new self-contained subdirectory `alive-next/tv-next/`. It links directly against alive2's source-level APIs — no subprocess spawning, no parsing of alive-tv's textual output. We reuse rather than reimplement IR loading, SMT initialization, and the per-pair refinement checker; the pilot adds the diff / cut / catalog / assume / compose machinery on top.

> Companion: [`IDEA.md`](IDEA.md) — the design rationale and the four sub-cases of the compositional frame this plan operationalizes.

---

## Goal

**Verify all seven worked examples from `alive-next.md`.** Each example exercises a distinct sub-case of the compositional frame; success on all seven demonstrates the pilot covers the full structural progression.

The exit criterion for the pilot is binary: every example verifies. Performance targets and corpus-wide recovery rates come *after* the pilot proves itself on the curated set.

---

## Current status (updated as work lands)

| Test | Phase | Mechanism | Verdict |
|------|-------|-----------|---------|
| `e1.srctgt.ll` | 1 | single-instr catalog dispatch | ✅ PASS |
| `e1alt.srctgt.ll` | 1 | + add-comm catalog entry, ptrtoint identity | ✅ PASS |
| `e2.srctgt.ll` | 2 | multi-instr group lift | ✅ PASS |
| `varB.srctgt.ll` | 2 | multi-instr group lift | ✅ PASS |
| `varA.srctgt.ll` | 3 | scalar assume + `tryNoOverflowMulFromExt` proposer | ✅ PASS |
| `e4.srctgt.ll` | 3+5 | freeze drop + range-from-mask proposer | ❌ timeout (Phase 5 range-analysis proposer needed) |
| `e3.srctgt.ll` | 4 | multi-side diff + single alive2 call on full vector region | ✅ PASS |

**Phases 1–4 complete.** Six of the seven examples verify end-to-end via the canonical CLI:

```bash
./alive-tv-next --disable-undef-input --smt-to=60000 path/to/foo.srctgt.ll
```

The one remaining failure (`e4`) is the Phase 5 milestone — not a regression.

Notes on the implementation as it landed:

- **No catalog yet.** M2.2/M2.3 (catalog format + pattern matcher) were not strictly necessary for the test set. The pilot dispatches every cut directly to alive2's `TransformVerify::verify`. Catalog caching is a performance optimization for later.
- **Commutativity-splitting heuristic** in `diff.cpp` replaces the catalog-aware grouping originally planned for M2.3. When walking diff positions, a position whose src/tgt have the same opcode + same operand multiset + same result name (i.e., commutativity-shaped) is split into its own group. This keeps the joint SMT formula small for `e2` (where `mul-comm` would otherwise over-group with the joint zext+sub ↔ sext+add rewrite into a SMT-hard `{3,4,5}` cut).
- **`--dump-cuts DIR`** developer flag implemented; writes each generated cut to `<DIR>/<sanitized-name>.srctgt.ll`. Found load-bearing while diagnosing the e2 timeout.
- **`--disable-undef-input` is required** for the test set's nsw-arithmetic cuts to verify in reasonable time. This matches alive-tv's standard usage convention.
- **Multi-side diff** (Phase 4) added to `diff.cpp`: unequal-count functions are handled by walking the prefix in lockstep (identical positions and same-named paired diffs extracted as normal groups), then gathering the remaining tail on each side into one multi-side `DiffGroup`. `cut.cpp` builds the multi-side cut via `buildMultiSideCut`, reusing the existing `buildGroupHalf` / external-operand-union logic.
- **Per-lane lifting was not needed for e3.** The multi-side cut for e3's vector region is handed directly to alive2, which verifies it in one shot — insertelement / extractelement / vector-sdiv reasoning is within Z3's reach at 60 s. Per-lane lifting (M4.2–M4.4) remains available as a future performance optimization if the direct path times out on larger vector regions.
- **`--tv-verbose`** flag (renamed from `--alive-tv-next-verbose`). Multi-side groups are counted separately in the summary line, e.g. `2 group(s) (1 multi-side)`.
- **`--dump-cuts` now also dumps proposer-internal cuts** (modified cut + assume-check) when a proposer fires, to `<dir>/<name>+assume.srctgt.ll` and `<dir>/<name>/assume-check.srctgt.ll`.

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
       │      Assume proposer        (Phase 3 hand-coded shape proposers;
       │      ├── hand-coded          Phase 5 range-analysis-backed proposers
       │      ├── range-analysis      (untrusted helper — alive2 is still the
       │      └── LLM (--model …)     soundness gate); Phase 6 LLM fallback
       │                              for what the previous tiers don't cover.
       │                              All produce a candidate `cond`.)
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

- A `tv-next` static library at `alive-next/tv-next/` (alive2-style: parallel to `ir/`, `smt/`, `llvm_util/`, etc.) holding the diff / cut / verify / compose primitives.
- An entry point at `tools/alive-tv-next.cpp` (parallel to `tools/alive-tv.cpp`), driving load → diff → cut → verify → compose.
- The executable `alive-tv-next` is registered in the top-level `CMakeLists.txt` and linked against `tv-next` plus `ALIVE_LIBS_LLVM`, Z3, hiredis, and the LLVM libs (same set `alive-tv` uses).
- `main()` scaffolding modeled on `tools/alive-tv.cpp` (LLVM init, `smt_initializer`, `.ll` parsing); inherits alive-tv's flag surface via `llvm_util/cmd_args_list.h`.
- `tv-next/ir_load.{h,cpp}`: parse a `.ll` file (single file with `@src`+`@tgt`, or two `.ll` files), call `llvm_util::llvm2alive` on each function to get `IR::Function`s.
- `tv-next/diff.{h,cpp}`: pair-walk pre and post, tag each position as identical or differing. Phase 1 requires equal instruction count.
- `tv-next/cut.{h,cpp}` (single-instr): for each diff position, build a small `tools::Transform` whose `src` and `tgt` each contain one instruction with its operands lifted to function parameters and the result returned.
- `tv-next/verify.{h,cpp}`: call `TransformVerify::verify()` per cut; on `Errors::isUnsound() == false`, the cut passes.
- `tv-next/compose.{h,cpp}`: identity-compare unchanged positions (textual match modulo metadata + SSA renaming); ensure operand-dependency chain is consistent across cuts. `ptrtoint` and other casts that appear identically on both sides hit the identity path, no cut needed.

### Deliverables

| ID | Deliverable | Status |
|----|-------------|--------|
| M1.1 | CMake targets (`tv-next` library + `alive-tv-next` executable) + `main()` scaffolding + `ir_load`; loads a paired `.ll` test file end-to-end | ✅ done |
| M1.2 | `diff` + single-instr `cut` + `verify` (per-cut `TransformVerify::verify`) | ✅ done |
| M1.3 | `compose` (identity comparison + dependency-chain check); end-to-end CLI returns a verdict | ✅ done |
| M1.4 | **Example 1 verifies end-to-end** | ✅ done |
| M1.5 | **Example 1' verifies end-to-end** (same mechanism, exercises `add` commutativity and `ptrtoint` identity path) | ✅ done |

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

| ID | Deliverable | Status |
|----|-------------|--------|
| M2.1 | Multi-line diff grouping logic + multi-line cut builder | ✅ done — runs of consecutive diffs become one group; `buildGroupCut` lifts a group as one Transform |
| M2.1b | Commutativity-splitting heuristic (added during e2 diagnosis) | ✅ done — same-opcode + same-operand-multiset + same-result-name diffs get isolated groups |
| M2.2 | Catalog format + verifier; populate with the entries above | ⏸ deferred — not needed for Phase 2 examples; the per-cut alive2 path handles them once cuts are correctly sized |
| M2.3 | Pattern matcher (single + multi-line) | ⏸ deferred — same reason |
| M2.4 | **Example 2 and Variant B verify end-to-end** | ✅ done |

**Phase 2 exits when Examples 1, 2, and Variant B all verify.** ✅ Done (e1, e1alt, e2, varB all PASS). Catalog (M2.2/M2.3) deferred — Phase 2 examples don't strictly need a catalog; the per-cut alive2 path handles them after the commutativity-splitting heuristic. Catalog will revisit as a perf optimization (caching) and as proof-template plumbing once Phase 3 lands.

---

## Phase 3 — assume mechanism (Variant A)

**Targets:** Variant A. (Example 4 was originally grouped here on the "scalar assume-needed" axis but its assume — range from `and`-mask — moves to Phase 5 once a small range analysis exists, and its diff requires Phase 4's length-mismatch support, so it lands as a Phase 4 + Phase 5 milestone.)

The pilot's input remains a raw slice (`pre.ll` / `post.ll` or `combined.srctgt.ll`) — assumes are **not** part of the input. `alive-tv-next` derives them itself.

### What it adds

- **Proposer infrastructure (`tv-next/proposer.{h,cpp}`).** A dispatcher `proposeAssume(cut, parent_src, parent_module, ctx)` runs hand-coded proposers in turn. A proposer recognizes a specific rewrite shape, derives a candidate precondition `cond` from the surrounding IR, and emits two artifacts:
  1. A *modified cut* — the original cut with `llvm.assume(cond)` injected before the rewrite on both sides. alive2 verifies this for the actual rewrite under the assume.
  2. A *standalone assume-check* — a small Transform that recomputes `cond` from the parent's relevant inputs and asserts it always holds (vs. `i1 true`). This is the soundness gate; if it fails the proposer's hypothesis is wrong and the proposal is rejected.
- **One proposer in Phase 3:** `tryNoOverflowMulFromExt`. Recognizes a `mul A, B` → `mul nsw A', B'` rewrite (commutativity allowed) where both operands trace back through one integer extension (`sext` or `zext`) to the mul's destination type in the parent `@src`. Emits the no-signed-overflow predicate via `llvm.smul.with.overflow.iN`. Feasibility for any (M, K, N) bitwidth combo is decided by alive2 on the assume-check, not encoded as arithmetic in the proposer.
- **Verify retry path (`verify.cpp`).** When a cut returns `Unsound` or `FailedToProve` and the parent context is supplied, `verifyCut` consults `proposeAssume`. If a proposer fires, the assume-check is verified first (must always hold); on success the modified cut is verified next; on success the verdict is upgraded to `Correct` with `proposer_name` set. If either retry-step fails, the original verdict stands with a diagnostic appended.
- **Driver wiring.** `alive-tv-next.cpp` threads `parent_src` and `parent_module` through `verifyCut`. Verbose mode prints `(via <proposer>)` on retried passes.
- **Range-from-mask proposer (for Example 4)** is deferred to Phase 5, where a small range analysis becomes a cleaner foundation than hand-matching the `and`-mask shape.
- **Catalog entries with preconditions** — same caching question as M2.2/M2.3; deferred. The current path consults the proposer directly on Unsound/FailedToProve verdicts, no catalog needed.

### Concrete proposers / assumes for the test set

- **Variant A — `A2`:** "the `mul i64 %v0, %v1` does not signed-overflow" — emitted by `tryNoOverflowMulFromExt` when both `%v0` and `%v1` are seen as `sext i32 → i64` in `@src`. ✅ verifies.
- **Example 4 — `A1`:** "%v0 < 64" — needs the range-from-mask shape, which lands in Phase 5 (range analysis). Also gated on Phase 4's length-mismatch diff (e4 has 5 src instructions vs. 4 tgt instructions).

### Deliverables

| ID | Deliverable | Status |
|----|-------------|--------|
| M3.1 | Catalog entries with preconditions | ⏸ deferred — same reason as M2.2/M2.3; proposer is consulted directly on Unsound/FailedToProve |
| M3.2 | Hand-coded assume proposer: `tryNoOverflowMulFromExt` (covers Variant A; the range-from-mask side moves to Phase 5) | ✅ done |
| M3.3 | Assume verifier (per-assume alive2 query) + `llvm.assume` injection into cut builders | ✅ done |
| M3.4 | **Variant A verifies end-to-end** | ✅ done |

**Phase 3 exits when Variant A verifies on top of Phases 1–2.** ✅ Done. Example 4 is now a Phase 4 + Phase 5 milestone (length-mismatch diff + range analysis).

---

## Phase 4 — multi-side diff + direct alive2 verification (Example 3)

**Targets:** Example 3.

### What it adds

- **Multi-side diff** (`diff.cpp`). Walk the prefix of src and tgt in lockstep: textually identical pairs become identical positions; pairs with the same non-empty SSA result name but different text become standard (equal-count) DiffGroups with commutativity-splitting applied as usual. The first pair where neither condition holds breaks lockstep; everything remaining on each side is collected into one multi-side `DiffGroup` (`is_multi_side = true`, `src_region`, `tgt_region`).
- **Multi-side cut builder** (`cut.cpp`). `buildGroupCut` dispatches to `buildMultiSideCut` for multi-side groups. `buildMultiSideCut` reuses `collectExternalOperands` / `unionNamedOperands` / `buildGroupHalf` — the cut function parameters are the union of external operands across both region sides; the cut returns the last instruction's value on each side (which must share a type).
- **Direct alive2 verification.** The multi-side cut is handed directly to `verifyCut` — no per-lane lifting or catalog template matching needed. For e3, alive2 verifies the full insert/extract/vector-sdiv region in one shot at the standard 60 s timeout.

### What was not needed

Per-lane lifting (M4.2–M4.4) was planned as a decomposition strategy for cases where alive2 would time out on the full vector region. In practice, alive2's insert/extract/sdiv reasoning is fast enough on e3's 2-lane `<2 x i64>` region. The infrastructure for per-lane lifting is therefore deferred — it remains available as a future performance optimization if larger vector regions appear in the corpus.

### Deliverables

| ID | Deliverable | Status |
|----|-------------|--------|
| M4.1 | Multi-side diff detection + region tagging in `diff.{h,cpp}` | ✅ done |
| M4.2 | Multi-side cut builder in `cut.cpp` | ✅ done |
| M4.3 | **Example 3 verifies end-to-end** | ✅ done |
| M4.4 | Per-lane lifting infrastructure (walk insert/extract chains, per-lane scalar problems) | ⏸ deferred — not needed for e3; revisit if corpus surfaces larger vector regions that time out |
| M4.5 | Catalog / vectorization-template entry for the SLP pattern | ⏸ deferred — same reason |

**Phase 4 exits when Example 3 verifies.** ✅ Done.

---

## Phase 5 — small range analysis (proposer-internal, untrusted)

**Targets:** Example 4, plus broader proposer reach on the corpus going into Phase 6.

Phase 3 ships proposers that pattern-match a *specific shape* (e.g. "operand is `sext` from i32"). That doesn't scale beyond a handful of cases. Phase 5 introduces a small, **untrusted** range analysis as a proposer-internal helper: it suggests candidate predicates (e.g. "this value is in `[0, 31]`"), and alive2's existing assume-check mechanism (Phase 3) decides whether the predicate actually holds. A buggy analysis can only cause **incompleteness** (missed proposals), never **unsoundness**. The trust base stays at alive2 + LLVM IR semantics; the analysis is a heuristic for *generating* candidate predicates, not for *trusting* them.

### Why it's worth a phase

- Lifts the proposer from "match exact shape" to "operand has known bounds tighter than the target type."
- One range-aware proposer subsumes several Phase 3-style shape proposers (e.g. range from `sext`, `zext`, `and`-mask, `urem`, constant-fold all fall under one rule).
- Cheap rejection: skip the alive2 assume-check on cases where the analysis already shows the bound doesn't hold.

### What it adds

- **`tv-next/range.{h,cpp}` — range-analysis helper.** Pure header-and-cpp library, scope-restricted to one parent function and one cut. Walks `parent_src` from the cut's external operands toward function inputs, deriving simple bounds on the way. Initial coverage:
  - Constant ranges (`iN C` → `[C, C]`).
  - `and X, C` with non-negative C → `[0, C]`.
  - `urem X, C` → `[0, C-1]`.
  - `sext`/`zext` propagation through known ranges.
  - Constant-fold-style propagation through `add`/`sub`/`mul` when inputs have known ranges and the op doesn't widen.
  - Single recursion depth bound to keep the analysis cheap.
  - Returns `std::optional<KnownRange>` where `KnownRange = {ConstantInt low, ConstantInt high}`. No public API beyond proposer code.
- **Cut-local scope.** The analysis runs over the cut's relevant slice in the parent function — same scope as the existing proposers. (A divide-and-conquer "cut-of-cut" cutting algorithm that would expand this scope is a separate, later discussion; the present range analysis only assumes cut-local visibility.)
- **`tryFreezeDropFromRange` proposer.** Recognizes a `freeze X` whose operand is dropped on the tgt side. Uses the range analysis on the freeze's operand to derive non-poison conditions (e.g., for `shl Y, %v0`, the operand-range proves `%v0 < bitwidth`). Emits the predicate as `icmp ult %v0, <bitwidth>` and routes it through Phase 3's assume-check + injection mechanism.
- **`tryNoOverflowMul` (generalized).** Replaces / extends `tryNoOverflowMulFromExt`. Instead of pattern-matching `sext`/`zext` directly, consults `getRange` on each mul operand; if both ranges are known and tight enough, propose the no-overflow predicate. The current proposer becomes a special case (the analysis returns ranges through `sext`/`zext`).

### Trust-base discipline

The single load-bearing invariant: **the analysis never decides soundness.** Every predicate it suggests is verified by alive2 via the standalone assume-check before being injected into the cut. The codebase enforces this by routing every range-derived proposal through `proposeAssume` → `runOnce(assume_check)` → `runOnce(modified_cut)`. There is no "skip alive2 because the analysis is confident" path.

### Deliverables

| ID | Deliverable | Status |
|----|-------------|--------|
| M5.1 | `tv-next/range.{h,cpp}` covering the ops above; cut-local scope; no public API | ⏳ pending |
| M5.2 | `tryFreezeDropFromRange` proposer (range-from-mask case is the entry point) | ⏳ pending |
| M5.3 | Generalize `tryNoOverflowMulFromExt` → `tryNoOverflowMul` consulting the range analysis | ⏳ pending |
| M5.4 | **Example 4 verifies end-to-end** (Phase 4's multi-side diff is already in place; only the range-analysis proposer is missing) | ⏳ pending |

**Phase 5 exits when Example 4 verifies and the range-analysis-backed proposers demonstrably extend reach beyond Phase 3's shape-only matchers on a small set of corpus slices.**

---

## Phase 6 — LLM-driven proposers (corpus-scale reach extension)

**Targets:** alive-tv-timeout slices from the existing extracted corpus that Phases 1–5's hand-coded + range-aware mechanisms don't reach.

Phases 1–5 establish the *infrastructure* for compositional verification with hand-coded heuristics (Phase 3) and a small untrusted range analysis (Phase 5) covering the seven curated examples and a tail of corpus-shaped cases. Phase 6 turns on the actual long-tail reach extension that motivates Alive-Next: the LLM as a proposer for cuts and assumes that fall outside both the hand-coded catalog and the range analysis, with alive2 still doing every soundness-critical decision.

The per-example test set is replaced here by a corpus-scale evaluation: take alive-tv-timeout slices, run `alive-tv-next` with and without `--model`, measure the recovery delta.

### What it adds

- **LLM client (M6.1).** A small HTTP wrapper around the OpenAI-compatible chat-completion API. Auth via the `ALIVE_NEXT_LLM_API_KEY` env var, endpoint via `ALIVE_NEXT_LLM_BASE_URL`, model via `--model`. No streaming for the first version; synchronous request/response is enough.
- **LLM cut proposer (M6.2).** When alive2 times out on a group cut, prompt the LLM with the lifted IR and ask for a finer split (or a known-equivalence hint that decomposes the joint rewrite into smaller pieces). Each proposed sub-cut is verified via alive2 — proposals that don't verify are discarded silently. Upper bound on retry budget per slice.
- **LLM assume proposer (M6.3).** When no hand-coded proposer fires (and the range analysis can't supply a bound) for a precondition-needing rewrite, prompt the LLM with the local IR and ask for a candidate `cond` (in `llvm.assume`-compatible form: an `i1`-valued LLVM expression over the slice's local SSA values). Verify the assume standalone via alive2; on success, inject as `llvm.assume` and verify the rewrite under the assume.
- **Corpus harness (M6.4).** Test bench that runs `alive-tv-next` on every alive-tv-timeout slice in the corpus (the existing 28K-slice corpus from `extract.cpp` filtered by alive-tv `timeout` outcome). Records per-slice verdict, time, and which mechanism (catalog / hand-coded / range-analysis / LLM-cut-proposer / LLM-assume-proposer / fall-through) succeeded.
- **Reproducibility scaffolding.** LLM proposals + their alive2 verdicts are logged so a run can be replayed deterministically without the LLM by reading the log.

### Out of scope for Phase 6

The minimum-viable LLM integration only. Defer to follow-on phases:

- Structured prompt engineering / multi-shot examples / chain-of-thought.
- Model evaluations (which model best, latency-vs-recovery curves).
- Fine-tuning, RAG over the catalog, or multi-turn agent behavior.
- LLM contribution to catalog discovery (mining slices for new rule shapes — a separate "rule discoverer" mode).

### Deliverables

| ID | Deliverable | Status |
|----|-------------|--------|
| M6.1 | LLM HTTP client + `--model` wiring; lazy init (no errors when unused) | ⏳ pending |
| M6.2 | LLM cut proposer: prompt + response parsing + per-proposal alive2 verification | ⏳ pending |
| M6.3 | LLM assume proposer: prompt + `cond` parsing + standalone-assume verification + injection | ⏳ pending |
| M6.4 | Corpus harness: alive-tv-timeout slices → recovery-rate measurement (with and without `--model`) | ⏳ pending |
| M6.5 | **Recovery rate ≥ 30 % on the alive-tv-timeout corpus with `--model`** | ⏳ pending |

The 30 % floor is a placeholder — adjust once Phase 6 evaluation produces real numbers. The qualitative test is whether `--model` measurably extends reach beyond what hand-coded + range-analysis-backed heuristics alone deliver.

**Phase 6 exits** when M6.5's measurement is done and the recovery delta is positive and stable across the corpus.

---

## File layout

The pilot's code, catalog, and tests all live under one new subdirectory inside the cloned alive2 tree. Existing alive2 files are not modified except for one line in the top-level `CMakeLists.txt` to register the new subdirectory.

```
buildbench/
  extract.cpp                # existing
  optimize.sh                # existing
  alive-next/                # cloned alive2 source (existing, mostly untouched
                             #   except for the CMakeLists.txt additions for
                             #   the alive-tv-next executable + tv-next library)
    CMakeLists.txt           # registers alive-tv-next exe + add_subdirectory(tv-next)
    ir/, smt/, llvm_util/,
    util/, tv/, ...          # existing alive2 source libraries
    tools/                   # existing alive2 entry points + alive-tv-next.cpp
      alive-tv.cpp           # upstream
      alive-tv-next.cpp      # NEW — alive-next entry point, parallel to alive-tv.cpp;
                             #   wires load → diff → cut → verify → compose; inherits
                             #   alive-tv's flag surface via cmd_args_list.h
      ...                    # other upstream tool sources
    tv-next/                 # NEW library (parallel to ir/, smt/, llvm_util/, …);
                             #   flat layout, alive2 style.
      CMakeLists.txt         # builds the static library `tv-next`
      ir_load.{h,cpp}        # LLVM .ll loading + llvm2alive invocation
      diff.{h,cpp}           # pairing + diff (per-line, multi-line, multi-side)
      cut.{h,cpp}            # cut lifting → small IR::Function pairs
      lift_lane.{h,cpp}      # per-lane lifting for vector cuts (Phase 4)
      match.{h,cpp}          # catalog pattern matching (Phase 2)
      proposer.{h,cpp}       # hand-coded assume proposers + dispatcher (Phase 3);
                             #   Phase 5 adds range-analysis-backed proposers here
      range.{h,cpp}          # small untrusted range analysis used by proposers
                             #   (Phase 5); cut-local scope; not a public API
      verify.{h,cpp}         # per-cut dispatch via TransformVerify::verify
                             #   (Phase 3+: retries via proposeAssume on
                             #   Unsound/FailedToProve)
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
| `tools::Transform` | src/tgt pair + optional precondition | `cut.cpp`, `proposer.cpp` |
| `tools::TransformVerify::verify()` | run a refinement check, return `util::Errors` | `verify.cpp` |
| `IR::Predicate` | first-class precondition object | `proposer.cpp` (only if a future proposer needs structured preconditions; current proposers express assumes as `llvm.assume(i1)`) |
| `smt::smt_initializer` | SMT context lifecycle | `tools/alive-tv-next.cpp` |
| `llvm_util::Verifier` | high-level reference path used by `alive-tv.cpp` | `tools/alive-tv-next.cpp` (model only) |

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

4. **Hand-coded proposer coverage.** Phase 3's `tryNoOverflowMulFromExt` is tied to a specific rewrite shape (`mul → mul nsw` over extension chains). New rewrites in later corpora will need new proposers. Phase 5's range analysis softens this: one range-aware proposer subsumes several shape-specific ones. Phase 6's LLM-driven generic proposer remains the eventual answer for the long tail. Assumes themselves are expressed via `llvm.assume(i1)` — LLVM's standard intrinsic, no project-specific DSL needed. The range analysis is **untrusted** by construction (every predicate it suggests is verified by alive2 before injection), so it doesn't expand the trust base.

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
