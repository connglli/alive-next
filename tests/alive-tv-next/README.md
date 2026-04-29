# alive-tv-next reference tests

Curated test cases for the alive-next pilot at `alive-next/tv-next/`. Each `.srctgt.ll` here is one of the seven examples enumerated in [`../../PLAN.md`](../../PLAN.md) — the canonical test set the pilot must verify.

## Mapping

| File | Example | Mechanism | Phase |
|------|---------|-----------|-------|
| `e1.srctgt.ll` | Example 1 | single-instr catalog dispatch | Phase 1 |
| `e1alt.srctgt.ll` | Example 1' | single-instr catalog (adds add-comm + ptrtoint identity) | Phase 1 |
| `e2.srctgt.ll` | Example 2 | multi-instr catalog dispatch (sub-of-zext ↔ add-of-sext) | Phase 2 |
| `varB.srctgt.ll` | Variant B | multi-instr + strength reduction + flag relaxation | Phase 2 |
| `varA.srctgt.ll` | Variant A | flag-addition with range-from-sext assume | Phase 3 |
| `e4.srctgt.ll` | Example 4 | scalar assume-needed (freeze drop, range-from-mask) | Phase 3 |
| `e3.srctgt.ll` | Example 3 | vectorization with per-lane lifting + poison-flow assume | Phase 4 |

## Running with `alive-tv` (current state)

These files are in alive2's standard `.srctgt.ll` format, so the existing lit infrastructure in `tests/lit.cfg.py` collects them automatically. Running `lit tests/alive-tv-next/` invokes `alive-tv` on each. Expected outcomes today, before the `alive-tv-next` binary exists:

- **e1**, **e1alt**, **varB** — likely *correct* on alive-tv directly (catalog rewrites are individually within Z3's reach when the slice is small enough).
- **e2** — *correct* or *unknown* (multi-instr rewrites with poison-flow can stress alive2).
- **varA**, **e4** — likely *unknown* / *timeout*: the precondition reasoning (range-from-sext, range-from-mask) chains analyses Z3 doesn't terminate on quickly.
- **e3** — *timeout*: vectorization + nonlinear chain on i64.

Lit's policy treats `timeout` and `unknown` as PASS (lenient). That's fine — these tests document what alive-tv struggles on; the pilot's job is to recover them via decomposition.

## Running with `alive-tv-next` (target)

When the pilot's binary exists, every test here should pass under `alive-tv-next` via the mechanism listed in the table. That's the pilot's exit criterion (PLAN.md, "Goal" section).

## Conventions in these files

- Comments at the top of each file document the example mapping, the diff, the catalog rules / lemmas / assumes used, and (where applicable) why alive-tv struggles directly.
- Function attributes that opt added on the post-opt side (`mustprogress`, `nofree`, `norecurse`, `local_unnamed_addr`, etc.) are preserved when they appeared in the source corpus, since they're part of the realistic test material. Inferred parameter attributes that were noted in the original write-ups (`captures(address_is_null)` etc.) are kept too.
- For each test, `@src` is the pre-opt slice and `@tgt` is the post-opt slice.

## Provenance

Each example's source is documented in [`../../IDEA.md`](../../IDEA.md) (the design rationale) and [`../../PLAN.md`](../../PLAN.md) (the test-set table with mechanism mapping). The slices themselves were extracted from real corpus runs (E1, E1', E2, E3, VarA, VarB) or constructed pedagogically (E4).
