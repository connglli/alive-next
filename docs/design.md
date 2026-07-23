# alive-next: Design

Agent-driven, alive2-certified translation validation for large LLVM IR programs.
This document records the design decisions we have agreed on, at the idea level
and at the tool level. It supersedes `draft.md`.

## Problem

Translation validation checks that a target program (RHS) is a refinement of a
source program (LHS). alive2 is the standard tool for LLVM, but it sends the
whole problem to an SMT solver in one query, so it does not scale to large
programs. alive-next keeps alive2 as the checker but uses an agent to break the
problem into pieces that alive2 can handle.

## Insight

The approach rests on two observations. Each one turns a single big validation
problem into many small ones, and they attack orthogonal dimensions of "big".

**1. Compositional reasoning shrinks the *size* of each check.** A large
program can be cut into components, each validated separately. For the pieces
to compose back into a whole-program result, the interface between adjacent
components must line up: whatever the first component guarantees at the cut
(its post-condition) is exactly what the second component may assume (its
pre-condition). If every component pair is validated and every interface is
justified, the whole program is validated. Each check now covers a fragment
instead of the whole program, which is exactly what the SMT solver needs.

**2. Refinement is transitive, so a *chain of small rewrites* shrinks the
semantic gap.** Instead of proving LHS refines to RHS in one step, we
transform LHS step by step, the same way a compiler applies a sequence of
local, semantics-preserving transformations, until it becomes RHS. If every
step in the chain is a refinement, the composition is a refinement. Each step
is a small, local change, so validating one step is far easier than validating
the end-to-end translation. Analyses (known bits, ranges, aliasing) supply the
facts that justify individual steps, just as they do inside a compiler.

The two combine naturally: decomposition cuts the program into chunks small
enough to check, and rewriting closes the semantic distance within and across
chunks, including massaging LHS until cut points that match RHS exist at all.
What makes the combination hard in practice is search: where to cut, which
rewrite to apply next, which facts to establish first. That search problem is
what we hand to an agent. The correctness problem stays with the checkers,
which is the subject of the next section.

## Core principle: agent proposes, checker certifies

The agent is entirely untrusted. It decides *what* to try: where to cut the
program, which rewrites to apply, which interface facts to add, which
counterexample candidates to test. Nothing the agent does can break soundness,
because every step must pass through a certifying check before it counts:

- Rewrite steps are validated by alive2 (or applied via pre-proved rules).
- Interface facts are validated by alive2 as annotation steps.
- Counterexamples are validated by concrete execution replay.

A wrong proposal wastes time; it never produces a wrong certificate. Since
refinement is transitive, a chain of certified steps from LHS to RHS certifies
the whole translation.

## Scope (v1)

Straightline code (no conditionals, no loops), but **all** features alive2
supports, including memory operations. Target size: >1000 lines. Conditionals
and loops are future work and need further design.

## Conceptual model

The framework state has two parts: an immutable **program store** and a
**goal tree**. Every tool reads or evolves this state; the agent can only act
on it through the tools.

**Programs.** A program is an immutable piece of IR with a unique ID (`p1`,
`p2`, ...). Every operation that changes code produces a new program under a
new ID; nothing is ever edited in place. This is what makes revert trivial and
the certificate a plain log.

**Goals.** A goal is the unit of proof: a pair `(src, tgt)` with the claim
"tgt refines src". A goal has an ID, a status (`open`, `proved`, `split`,
`refuted`), and one history per side recording how that side evolved. Goals
form a tree; the root goal is `(LHS, RHS)`. The overall verdict is derived
from the tree, never asserted: root proved means verified, root refuted by
replay means counterexample, anything else means unknown.

**Sides and validation direction.** Each goal has a `src` side and a `tgt`
side, and either side may be rewritten. The direction of the required check
depends on the side, and the framework owns this; the agent never chooses a
direction:

- A step on the `src` side replaces S with S' and must show S' refines S
  (alive2 with src=S, tgt=S'). Then "tgt refines S'" plus this step gives
  "tgt refines S" by transitivity. This is optimizing the source forward.
- A step on the `tgt` side replaces T with T' and must show T refines T'
  (alive2 with src=T', tgt=T). Then "T' refines src" plus this step gives
  "T refines src". This is deoptimizing the target backward.

**Steps.** A step is a certified transition on one side of one goal. A step is
certified in one of two ways: by applying a pre-proved rewrite rule (no alive2
run needed), or by an alive2 check of the before/after pair in the
side-appropriate direction. The head of a side is the latest program in its
history; all tools operate on heads.

**Transactions.** A transaction is an editing session on one side of one goal.
Between `begin` and `commit` the agent makes arbitrary edits and gets cheap
feedback (parse errors, straightline check, analyses); the intermediate
programs are scratch and never enter any certificate. At `commit`, alive2
validates the whole before/after pair as a single step. On failure the head is
unchanged and the local counterexample is returned as a hint. There is no
separate "checked rewrite" concept: a checked rewrite is a transaction with
one edit. Likewise, inserting `llvm.assume(c)` on the src side and committing
*is* a proof that `c` always holds; annotation is not special machinery.
(An assume inserted on the tgt side commits trivially, but the obligation
resurfaces in the remaining goal, so it defers work rather than avoiding it.)

**Certificate.** The deliverable of a successful run: a standalone package
(IR files, a manifest, a checker script) that replays the whole proof through
alive2 with no framework and no agent involved (see "Certificate package").
It contains only the pruned proof, the goals and steps that actually
discharged the root; reverted or abandoned search never appears in it. A
refuted root has the symmetric package: the input plus a script that replays
both programs under llubi and confirms the divergence.

## Decomposition = outlining

Cutting a program in two while memory flows across the cut needs a notion of
"the state at the cut in RHS refines the state in LHS", including memory. We do
not define that ourselves. Instead, `split` outlines the suffix:

- Outer program: `A; call g(...)`, where `g` is a fresh declared function.
- Callee: a function `g` whose body is `B`.

Two alive2 checks replace the one big check:

1. The outer pair, with `g` left as an unknown declared function. alive2
   treats a call to an unknown function as an observable event: the arguments
   and memory reaching the call in RHS must refine those in LHS. That *is* the
   cut condition, memory included, and we inherit it from alive2's own
   semantics instead of writing our own composition theorem.
2. The callee pair `g_lhs` vs `g_rhs`, as a normal function-level check.

The declared `g` must have one signature shared by both sides. The signature
is determined by the src side's live values at the cut, and the agent must
supply a value map saying which tgt value corresponds to each src live value.
Whether the map is *correct* is not trusted: alive2's outer check verifies
that corresponding arguments refine each other. If the tgt suffix needs a
value with no src counterpart at the cut, the split fails structurally; that
is the signal to rewrite one side first until the cut points align.

The only trusted glue is that the outlining transformation itself is faithful
(the outer program plus the callee really is the original program). That is
mechanical and small.

Known cost: alive2 is conservative at function entry (arbitrary memory,
arbitrary aliasing) and around unknown calls (code cannot move across the cut).
So a bad cut placement produces spurious failures. That is fine: cut placement
is the agent's job, and a local failure is feedback to the agent, never a bug
report. When a cut fails because facts established before the cut are lost, the
fix is interface strengthening (below).

Open item: confirm with alive2's docs/developers that its function-level
refinement is contextual in the corner cases we rely on (pointer provenance,
escaped pointers).

## Interface facts are proved where the evidence lives

To make a callee goal provable, it may need facts about its inputs: `noundef`,
`align`, `dereferenceable`, value ranges, known bits, aliasing facts. These
are expressed as attributes on `g`'s parameters, assumed by the callee goal
and enforced at the call site.

Putting an attribute on `g` is not free. If the fact were false, the annotated
outer program would have UB where the original does not, and outlining would
stop being faithful. The sound recipe has two phases, both certified steps:

1. Prove the fact: insert `llvm.assume(c)` just before the call in the outer
   src program and validate the insertion with alive2. This query scales with
   the outer program, because that is where the evidence for `c` lives.
2. Only then rewrite `g`'s declaration with the attribute, in the outer goal
   (both sides) and the callee goal's signature. With the assume in place this
   adds no new UB, and the step is cheap to validate.

This is the deepest cost item in the design: a fact assumed by a callee is
proved in its outer goal. The cost control is hierarchical splitting, so that
each fact is proved inside a chunk-sized goal rather than at the top level.
Split placement and fact placement therefore interact, and that interaction is
part of the agent's search problem.

## Analyses are untrusted proposers

Analyses only propose facts; a fact enters the certificate solely through an
annotation step that alive2 proves. Because of that, we reuse LLVM's own
analyses (known bits, value ranges, alias analysis) directly: a bug in them
wastes time on rejected facts but cannot corrupt a verdict, and linking them
into the framework adds nothing to the trust base, since the framework is
untrusted anyway and `check.py` never runs an analysis. The `analyze` tool is
a thin adapter that runs an LLVM analysis at a program point and reports the
facts in a form that maps directly onto attributes and assumes. We write an
analysis of our own only where LLVM has no fitting one, for example queries
shaped around a planned cut; reimplementing what LLVM already does well would
buy nothing.

"Untrusted" here means one specific thing: a bug in an analysis cannot change
a verdict. A false fact can be proposed, but it cannot pass alive2, and
`check.py` never executes an analysis, so certificate consumers do not depend
on them at all. This is the proof-assistant architecture: tactics are large
and buggy and nobody cares for soundness, because the small kernel checks
every proof they produce. Our analyses are tactics; alive2 and `check.py` are
the kernel. Note that untrusted does not mean carelessly built: the success
rate of the whole tool rides on analysis quality, so they are engineered and
tested like any normal software. They are just not verification-critical.

## Counterexamples: certified by execution, not by SMT chains

A local validation failure gives a counterexample for a chunk, but the chunk's
entry state may be unreachable from the real program inputs, so a local
counterexample is only a hint. We do **not** lift it by backward SMT
reachability (dropped from the draft: chaining concrete witnesses backward is
incomplete, and carrying symbolic constraints backward regrows the monolithic
query).

Instead, a counterexample is certified by replay: a concrete whole-program
input on which LHS and RHS are run under a UB/poison-aware interpreter
(llubi), and RHS shows a behavior LHS does not allow. That check is cheap,
independent of program size, and replayable by anyone.

The search for that input is fully untrusted, so the agent gets full
flexibility: infer candidate values from analyses, run chunks forward
concretely with `interp`, solve chunk-local inversion queries with `solve`,
compute in `bash`/`python`, or guess. Prefer inputs on which LHS runs
deterministically (no undef in play), so that "divergence" is crisp.

For programs with memory operations, an input means argument values plus the
initial contents of the memory the pointer arguments point to; divergence
compares the return value, the final observable memory, and UB events.

## Eager cross-checking

A certified step shows the step is valid; it says nothing about whether the
path still leads anywhere. So after every certified step (a commit, an apply,
a strengthen), the framework immediately runs a small-timeout `check` on the
goal's new current pair:

- Proved: the goal discharges early. In particular, the last step of a
  successful chain discharges the goal without an explicit `check` call,
  since alpha-equivalence is tried first.
- Timeout: no information, continue.
- Refuted with a concrete counterexample: the current pair can never be
  proved, so the framework marks the path dead, forcing a revert or an
  unsplit, and returns the counterexample as a hint.

Interpreting a refutation depends on where it happens. On a goal whose sides
have been rewritten, it may blame only the path: a valid step can overshoot.
Example: S returns `undef`, a valid step refines it to S' returning `0`, and
T returns `1`. T refines S, and S' refines S, but T does not refine S'; the
translation is fine and only the path is dead. On a callee goal, it may
instead mean the interface is too weak (strengthen it) or the cut is
misplaced (unsplit and cut elsewhere), since the callee's entry is
conservative. None of these refute the translation by themselves.

A refutation on the root goal is special, because its counterexample speaks
the root input language whether or not steps have been applied. The framework
therefore auto-replays it against the original LHS/RHS pair under llubi. If
the replay confirms divergence, the run ends with a certified counterexample;
this is the common way a real miscompilation surfaces early, and with zero
steps applied the replay nearly always confirms. If the replay does not
confirm, the counterexample was an artifact of the path and remains a hint.
Either way the verdict comes only from the llubi replay, never from alive2's
refutation directly, keeping one uniform rule: counterexamples are certified
by execution. For callee goals the counterexample speaks the cut language,
and lifting it to a root input remains the agent's search problem.

## Workflow

A session looks like this:

1. The framework creates the root goal `(LHS, RHS)`.
2. The agent inspects (`status`, `show`, `diff`, `analyze`) and picks a
   strategy: usually, find aligned cut points and `split`, rewriting one side
   first when no alignment exists yet.
3. On each open leaf goal: if it looks small enough, `check` it directly.
   Otherwise rewrite the src toward the tgt (`apply`, transactions),
   `strengthen` interfaces where the callee lacks facts, and `split` further.
4. A failed commit, a failed check, or an eager cross-check refutation
   returns a local counterexample as a hint. The
   agent either treats it as search feedback (revert, try another path) or
   investigates it as a possible real miscompilation: use `interp`, `solve`,
   `bash`/`python` to hunt for a whole-program input, then `report_cex` to
   certify it.
5. The session ends when the root goal is proved (verified), the root goal is
   refuted (counterexample), or the budget runs out (unknown).

## Tools

Every tool call is logged. Tools that create certified steps record enough to
replay the check. IDs: `pN` for programs, `gN` for goals; tool parameters
named `pid` and `gid` take these IDs.

### Inspection (no state change)

- `status()`: the goal tree with statuses, current heads, open transactions,
  and open obligations.
- `show(pid | gid)`: the text of a program, or the details of a goal.
- `diff(pid1, pid2)`: textual diff between any two programs.

### Splitting

- `split(gid, src_cut, tgt_cut, value_map)`: outlines both sides of an open
  goal at the given cut points (a cut point names a position in the
  instruction sequence by the value defined there). The src side's live
  values at the cut define `g`'s signature; `value_map` gives the
  corresponding tgt values. Creates two child goals (outer and callee);
  the parent's status becomes `split` and its heads are frozen. The parent
  is proved automatically when both children are. Fails structurally if the
  map is ill-typed or the tgt suffix uses values not covered by the map.
- `unsplit(gid)`: discards a split goal's children (and their subtrees) and
  reopens the parent. The way to undo a bad cut.

### Rewriting

- `apply(gid, side, rule_id, location)`: apply a pre-proved rewrite rule at
  a location on the head of the given side. Certified without running alive2;
  the result becomes the new head.
- `begin(gid, side)`: open a transaction on the head of the given side. At
  most one open transaction per goal side; other tools on that goal side are
  rejected until `commit` or `abort`.
- `edit(op)`: one edit inside the open transaction. Edit operations are
  semantic, not positional: each op is one coherent action that also carries
  out its consequential changes elsewhere in the body, so an intent takes one
  call instead of several raw edits. Initial catalog, extensible as we learn
  what agents actually need:
  - `swap(%a, %b)`: exchange the positions of two instructions.
  - `move(%v, before|after, %w)`: reposition one instruction.
  - `substitute(%a, %b)`: replace all uses of `%a` with `%b`.
  - `replace(%v, insts)`: redefine `%v` with a new instruction sequence.
  - `insert(before|after, %w, insts)`: insert new instructions.
  - `erase(%v)`: delete an instruction, optionally cascading to operands
    that become dead.
  - `commute(%v)`: swap the operands of a commutative operation.
  - `retype(%v, ty)`: change a value's type (e.g. narrow `i32` to `i22`
    after a known-bits fact), inserting trunc/ext fixups at the definition
    and all uses.
  - `dedup(%a, %b)`: merge duplicate computations: erase `%b` and
    substitute its uses with `%a`.
  - `set_body(text)`: the whole-body escape hatch.

  Each edit gets cheap feedback (parses, stays straightline); no alive2
  involved, and every edit stays uncertified until `commit`.
- `commit()`: validate the transaction's whole before/after pair with alive2
  in the side-appropriate direction. Success: one certified step, head
  advances. Failure: head unchanged, local counterexample returned as a hint.
- `abort()`: discard the transaction.
- `revert(gid, side, pid)`: move the head of an open goal's side back to
  an earlier program in its history. Later steps are abandoned (kept in the
  log, unused).

### Interface strengthening

- `strengthen(gid, param, fact)`: the two-phase recipe as one tool; `gid`
  must be a split goal.
  Phase 1: insert `llvm.assume(fact)` before the call in the outer src and
  validate with alive2 (this is where the proof cost lives). Phase 2: add the
  corresponding attribute to `g`'s declaration in the outer goal and the
  callee goal. Fails cleanly at phase 1 if the fact does not hold.

### Analyses

- `analyze(pid, kind, opts)`: run an in-house analysis (known bits,
  ranges, aliasing, ...) and return facts as untrusted proposals, in a form
  that maps directly onto `strengthen` facts or assume insertions.

### Discharge

- `check(gid, timeout)`: try alpha-equivalence first, then a direct alive2
  run on the goal's current pair. Pass: goal proved. Fail: local
  counterexample hint, goal stays open. Timeout: goal stays open. The timeout
  is the agent's knob, because spending solver time is a search decision.
  The framework also runs a small-timeout `check` on its own after every
  certified step; see "Eager cross-checking".

### Counterexample search and computation

- `interp(pid, args)`: run any program (chunk or whole, any version) on
  concrete inputs under llubi. Untrusted helper; results are information only.
- `solve(pid, spec)`: a chunk-local SMT query, e.g. find arguments that
  drive a small chunk to a given output, or check whether a candidate cut
  state is producible. Untrusted helper.
- `report_cex(inputs)`: the certifying check. The framework itself replays
  the root pair under llubi; only a confirmed divergence marks the root goal
  refuted and is recorded in the certificate.
- `bash(cmd)` / `python(code)`: general scratch computation for the agent.
  Untrusted; must not touch the program store or goal tree except through
  the tools above (see Implementation notes).

## Certificate package

A "verified" verdict is delivered as a self-contained package that anyone can
replay with only alive2, the rule applier, and a scripting runtime; the
framework and the agent are not needed. Layout:

- `programs/`: every IR version referenced by the proof, one file per
  program, named by content hash. Hash naming makes chain connectivity a
  trivial string comparison.
- `manifest.json`: the pruned goal tree. Per goal: its initial (src, tgt)
  hashes, its chain of certified steps, and how it was discharged. Per step:
  kind (rule, checked, split, strengthen), side, before/after hashes, and
  for alive2-backed steps the exact invocation (function pair, direction,
  options, timeout).
- `check.py`: a small standalone script that replays the proof, one step at
  a time.

The script verifies:

1. Chain connectivity: each step's before-hash matches the current head,
   starting from the root's LHS and RHS hashes.
2. alive2-backed steps and leaf discharges: rerun alive-tv on the recorded
   pair in the recorded direction; the result must be "correct". Replay
   timeouts should be more generous than the originals, since solver timing
   varies across machines.
3. Rule steps: re-apply the recorded rule at the recorded location and check
   that the output matches the after-hash.
4. Split faithfulness: inline the callee back into the outer program at the
   call site and check alpha-equivalence against the parent's program, per
   side. Mechanical for straightline code.
5. Alpha-equivalence discharges: recheck syntactic equality.
6. Composition: the root is verified iff every leaf discharge and every
   faithfulness check passed and every parent's children are accounted for.

The consequence for trust is significant: the framework is now just a search
assistant and drops out of the trust base entirely. Anything it gets wrong
(bookkeeping, direction, outlining) surfaces as a failed replay. The
composition rule and the faithfulness check live in `check.py`, which is
small, standalone, and auditable.

A "counterexample" verdict ships the symmetric package: the two root
programs, the input (argument values plus initial memory), and a script that
runs both under llubi and confirms that RHS shows a behavior LHS does not
allow.

Replay cost is the same order as the original validation run (the solver
queries are rerun); that is inherent to a certificate whose checker is
alive2 itself.

## Outputs

Exactly three:

- **verified**: a certificate package replaying the proof through alive2.
- **counterexample**: a package replaying a concrete input through llubi.
- **unknown**: the agent could not close the gap. Local failures along the
  way are never reported as bugs. No package is produced.

## Trust base

Two tiers, drawn by one criterion: can a bug here cause a wrong verdict to be
accepted? The line runs through the middle of our own implementation; it is
about verdict impact, not code ownership.

**Tier 1, verdict-critical (trusted).** Exactly what the certificate package
depends on:

- alive2, and transitively the SMT solver it trusts (Z3) and the LLVM IR
  parser/printer it links. This is the largest real-world risk in the whole
  trust base; everything else of LLVM is out.
- llubi, for counterexample verdicts only: a llubi bug cannot fake
  "verified" (that is alive2's side), only "counterexample", and a replay is
  a single concrete input that is easy to cross-check independently.
- The pre-proved rewrite rule applier (used by `check.py` to replay rule
  steps), together with the rules' external proofs.
- `check.py`: the small standalone checker that encodes chain connectivity,
  split faithfulness, and tree composition.

**Tier 2, success-critical (untrusted for soundness).** The framework, the
analyses, the agent, and `bash`/`python` scratch work. A bug here can waste
time, mislead the search, or end the run at "unknown"; it cannot survive a
certificate replay, so it cannot corrupt a verdict. These components are
still engineered and tested like normal software, because the tool's success
rate depends on them. The framework in particular orchestrates the search and
assembles the package, but its mistakes show up as failed replays, not wrong
answers.

## Implementation notes

- Built on the Pi agent framework.
- Store isolation: `bash`/`python` run where the agent can write files, so
  the program store and goal tree must not be reachable from that sandbox,
  or the framework must verify store integrity (content hashes) on every
  tool call. Otherwise "immutable store" silently becomes an isolation
  assumption.
- llubi driver: needs to run a single function with given argument values and
  initial memory for pointer arguments, and report return value, final
  observable memory, and UB events, so the replay check can compare the two
  sides. Wrap llubi with a small driver if it does not support this shape
  directly.
