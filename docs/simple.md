# The simple searcher

The simple searcher is a proof writer without a model. Like the agent, it is untrusted: it makes only the public moves of a session, so every step it takes is certified by alive2, llops or a verified rule, every cut is rebuilt by llops, and its certificate is replayed by the kernel like any other. `bun run simple a.ll b.ll` runs it and writes the same session directory as the agent and the examples. `bun run simple --help` lists its options, and `engine/simple/limits.ts` holds their defaults.

## What it searches for

A proof has three parts, and the searcher searches for each: a rewrite path, the chain of certified steps that moves the src toward the tgt; cuts and their preconditions, which split a goal and say what each new function may assume about its inputs; and loops and their invariants, which prove a loop by induction over one iteration.

| Part | The framework allows | The searcher tries | It does not try |
| --- | --- | --- | --- |
| Rewrite path | steps on either side, by transactions or rules, intermediate programs, and reverts | src region rewrites and rules, complete optimizer stages checked or searched as goals | tgt rewrite paths |
| Cuts and preconditions | cuts wherever both sides agree, with facts or predicates on the new parameters and return, and splits by cases | a loop header, an expensive operation, a region's boundaries, balanced points, a tested comparison; the analyses' facts on the inputs of a window or a cut | facts outside the analyses and predicate templates |
| Loops and invariants | cuts at a header or an exit, unfolding, invariants | the first header, where the diff matched one; invariants by Houdini | invariants of other forms |

The searcher first checks the root's original pair on a short budget, unrolled when it loops. A proof or a refutation, of the pair or at an input, ends the run. Otherwise it cleans the tgt's attributes and loop IDs, peels away bounded src loops missing from the tgt, and follows the optimizer's stages.

Each open goal starts with target attribute cleanup, including redundant return `noundef`. Unchanged edits are abandoned and changed programs require certification. Identical sides and control-flow reshapes close at once; other pairs receive a short alive2 check before cuts and the largest allowed check when cuts fail. Alive2 proves no pair that loops. A goal is cut while its budget remains, and its children are searched in the same way. Unsuccessful cuts are undone; a search that exhausts its moves names the goals left open.

## Rewrite paths

An unoptimized src and its optimized tgt share few instructions, while consecutive optimizer stages share most of theirs. The searcher runs `default<O3>` through `llops opt pipeline` and keeps complete modules from the stages that change the body. It follows them up to the last one closest to the tgt, then tries the tgt's windows unless it has already asked them on that goal. A stage is a proposal that requires proof; no stage is walked when every one is farther from the tgt than the src.

Before matching blocks, the search aligns ordinary `tail` markers on calls whose arguments contain no pointer. It proposes a marker on the source's calls only when the target's calls of that function all agree. Each edit is checked in its own window, which lets `reshaped` match calls across different block shapes.

The diff in `regions.ts` then aligns blocks by content and instructions by form, using longest common subsequences. Adjacent differences form a region; a commuted operation stands alone. The search steps through regions from last to first, keeping the positions of earlier regions stable.

A region becomes a step through the `splice` edit: a copy of the tgt's code replaces the region in the src. The copy reads the src partners of the values it reads, and the src's later uses read the partners of the values they used, both as the diff pairs them. The commit names the region as its window and does not ask the whole function. A region with one empty side, such as a deleted instruction, takes the shared instruction next to it, so that both windows hold something. A region with a phi or a terminator fits no window and is left to a cut.

When alive2 refuses a window, the searcher grows it backward over the instructions that define the values either side reads, and then tries it with preconditions.

An unfinished intermediate stage is interposed as a complete module, so attribute groups, metadata and declarations retain their context. The source-to-stage goal receives a whole-function check at the default check budget. A proof advances to the remaining goal; an undecided stage can be searched with its own cut budget. Failed attempts are undone, and each walk searches at most one undecided stage.

An undecided solver result stops further whole-stage checks on that walk. `--no-interpose` disables further search of an undecided stage while retaining whole-stage checks.

Region splices and rule rewrites change the src. Splicing the tgt's region into the src asks alive2 about the same two windows as the reverse edit. A rule rewrites wherever it matches, so the search applies the rules only when they reduce the instructions in the differing regions, then tries the windows again. Certified splices and rule rewrites are kept.

## Cuts and preconditions

A goal that does not close tries the cuts below in order. An instruction cut first tries a shared join reached from that point. If the join has no partner, the search copies shared acyclic blocks for outside paths and retries the instruction cut within the existing cut budget. A failed attempt with copied joins restores both programs.

* A loop: peel away a bounded src loop when the src has more loops than the tgt, or try matched headers as the next section describes.
* Just before one of the last three expensive operations both sides apply, latest first, so that it reads the same operands on both: a multiplication of two variables, a division, a remainder, floating-point arithmetic, a load, or a store. Calls do not count, since every cut adds one.
* Around the first region its steps left, whether no window could hold the region or alive2 refused its windows. The goal is cut after the region and then at its head, or at its block when it starts with a phi, so that the region stands in a goal of its own. That goal is not cut around a region again.
* Where both sides agree and its expensive operations divide most evenly between the two halves, trying the three most even points.
* By cases on a comparison of its parameters, or of a parameter and an integer, that its branches test: first one that both sides test, and a later branch before an earlier one. A parameter that may be poison is first split on whether it is poison. The cases stay only when a short check closes one of them at once. Each case assumes the comparison or its inverse, tries next only the comparisons after it, and does not count as a cut.

A cut passes crossing values through their matched tgt values and rebuilds missing src values from partners. Stack slots match through load users, the last store common to all paths, or a phi of the same type whose incoming values match the last stores on corresponding edges. Missing partners make the cut fail. A refuted goal instead strengthens its cut with comparisons from the counterexample or gives way to the next cut point.

A window is outlined as a cut is, and both can carry preconditions: facts about the new function's inputs, proved where it is called and assumed inside it. Inputs the src's analyses show cannot be poison get facts at both. An input that may be poison gets a fact only at a cut, and only a `range`. A window proves its facts by assuming them before its call, and an assumption about a poison value is undefined behavior. A cut proves its facts by putting them on the new function's declaration instead. There a value outside a range becomes poison rather than undefined behavior, so a range can hold even when the value may be poison. A window gets preconditions when alive2 refuses it. They are what the `defined`, `ranges`, `knownbits`, and `pointer` analyses know about its inputs just before it, as attributes, and they are tried together, so one that does not prove makes the attempt fail. A cut gets preconditions when it is made: `noundef` and the pointer facts as attributes, and as predicates the range bounds, the known bits and those its goal assumes; an input that may be poison gets only a `range` instead, the narrowest one its range bounds or its known bits allow. They are tried together, and when that is refused, the ones that hold when asked about alone are kept. ScalarEvolution proposes expressions over the parameters and linear relations such as `left == n - i`, with casts between integer widths.

## Loops and invariants

Loop cuts use the first src header and its matched tgt point, or a shared join that must be isolated first. Shared acyclic blocks get copies for paths outside the loop (`rotated`). A header cut leaves one iteration with hypothesis calls on its back edges.

If the ordinary loop cut does not prove the goal, the search tries copying the first header for its entry edges on each side in turn and repeats the cut. Each failed alternative restores both programs. These cuts use the goal's existing budget.

Header casts align the types at a loop cut. The search inserts and hoists a truncation of a wider tgt phi. For a wider src phi used only by a header truncation, it hoists that cast and erases the unused phi. Every step is certified, and unfinished preparation is reverted. Unfolding the other side's iteration or outer aligns unrolled or peeled loops (`unfold`, `peel`).

An iteration's proof often needs an invariant that holds on entry and is preserved by every iteration. `strengthen` proves both obligations and assumes the invariant at the iteration's start. The search finds invariants with Houdini. Candidates include both headers' analysis facts, including ranges for possibly poison values. Guesses include `noundef` for parameters without ranges, `ne 0` and `sge 0`, same-type integer comparisons (`ule`, `ult`, `sle`, `slt`, `eq`, `ne`), and inclusive signed and unsigned bounds from constants tested in the iteration. Examples are `key != 0` in `strchr` and `j <= i` in `loop`. Each round previews the strengthen and keeps candidates that hold on entry and that one iteration preserves with the rest assumed. For an iteration containing loops, the preview checks four inner iterations and llubi runs filter candidates. Once a round drops nothing, the search strengthens the cut with the remaining candidates. Loops stay open when these candidates do not yield a sufficient invariant.
