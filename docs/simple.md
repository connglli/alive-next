# The simple searcher

The simple searcher is a proof writer without a model. Like the agent, it is untrusted: it makes only the public moves of a session, so every step it takes is certified by alive2, llops or a verified rule, every cut is rebuilt by llops, and its certificate is replayed by the kernel like any other. `bun run simple a.ll b.ll` runs it and writes the same session directory as the agent and the examples. `bun run simple --help` lists its options, and `engine/simple/limits.ts` holds their defaults.

## What it searches for

A proof has three parts, and the searcher searches for each: a rewrite path, the chain of certified steps that moves the src toward the tgt; cuts and their preconditions, which split a goal and say what each new function may assume about its inputs; and loops and their invariants, which prove a loop by induction over one iteration.

| Part | The framework allows | The searcher tries | It does not try |
| --- | --- | --- | --- |
| Rewrite path | steps on either side, by transactions or rules, intermediate programs, and reverts | src steps through the optimizer's stages to the tgt, region by region, and by the rules, a stage no step reaches as a goal of its own | tgt steps, reverts |
| Cuts and preconditions | cuts wherever both sides agree, with facts or predicates on the new parameters | a loop header, an expensive operation, a region's boundaries, balanced points; the analyses' facts on the inputs of a window or a cut | relations that are not linear |
| Loops and invariants | cuts at a header or an exit, unfolding, invariants | the first header, where the diff matched one; invariants by Houdini | invariants of other forms |

The searcher first checks the root's original pair on a short budget, unrolled when it loops, and a proof or a refutation, of the pair or at an input, ends the run. Otherwise it drops from the tgt the attributes `llops respected` shows its instructions keep, steps the root's src along a rewrite path and checks each goal: identical sides, or a tgt that only reshapes the src's control flow, are proved at once, other sides are asked of alive2 briefly before a cut and on the largest budget when none lands, and alive2 proves no pair that loops. A goal that does not close is cut while cuts remain, and the goals a cut leaves are searched in the same way, the cut undone when they do not all close. A search that ends with open goals gives up and names them.

## Rewrite paths

An unoptimized src and its optimized tgt share few instructions, while consecutive stages of the optimizer share most of theirs. So the path runs through the stages of the toolchain's own `-O3`, and fits a tgt that this pipeline made: the searcher runs `default<O3>` on the src through `llops opt pipeline`, which keeps the program after each pass that changed it, and steps the src toward each stage with a new body up to the last one closest to the tgt, then toward the tgt unless that stage has its body. A stage is only a hint: a step toward it that alive2 refuses is dropped, and no stage is walked when every one is farther than the src.

A step toward a program goes region by region. The diff (`regions.ts`) matches the blocks of the two bodies by their contents and then the instructions inside each pair of matched blocks, each time as a longest common subsequence of `number`'s forms. Differences next to each other form a region. Regions are stepped from the last to the first, so that no step moves a region still to come.

A region becomes a step through the `splice` edit: a copy of the tgt's code replaces the region in the src. The copy reads the src partners of the values it reads, and the src's later uses read the partners of the values they used, both as the diff pairs them. The commit names the region as its window and does not ask the whole function. A region with one empty side, such as a deleted instruction, takes the shared instruction next to it, so that both windows hold something. A region with a phi or a terminator fits no window and is left to a cut.

When alive2 refuses a window, the searcher grows it backward over the instructions that define the values either side reads, and then tries it with preconditions. For a stage that its windows leave unfinished, it tries one step of the whole function to that stage, until alive2 cannot decide one. On a program that loops, where alive2 is asked about no whole function, a stage that neither reaches is interposed between the goal's sides: the step to it becomes a goal of its own, with cuts of its own, which is cut at its loops and given invariants like any goal, and the rest of the goal walks on from it. A walk interposes once, since a later stage holds the same changes.

Every step is on the src side, since putting the tgt's region into the src asks alive2 about the same two windows as putting the src's region into the tgt. A verified rule rewrites wherever it matches rather than toward a program, so the searcher applies all the rules to a goal its windows left open only when that leaves fewer instructions in the regions, and then steps the windows again. It keeps every step that is certified and reverts none.

## Cuts and preconditions

A goal that does not close is cut at the first of these that the framework accepts:

* Its first loop header, as the next section says.
* Just before one of the last three expensive operations both sides apply, latest first, so that it reads the same operands on both: a multiplication of two variables, a division, a remainder, floating-point arithmetic, a load, or a store. Calls do not count, since every cut adds one.
* Around the first region its steps left, whether no window could hold the region or alive2 refused its windows. The goal is cut after the region and then at its head, or at its block when it starts with a phi, so that the region stands in a goal of its own. That goal is not cut around a region again.
* Where both sides agree and its expensive operations split most evenly between the two halves, trying the three most even points.

A cut passes each crossing value as its tgt partner, and a tgt value the src lacks rebuilt from partners; one it cannot pass makes the cut fail. A refuted goal is never cut further, which cannot prove it: its cut takes the comparisons its counterexample breaks where they hold, or gives way to the next cut point.

A window is outlined as a cut is, and both can carry preconditions: facts about the new function's inputs, proved where it is called and assumed inside it. Only inputs the src's analyses find `noundef` get facts, since a fact about a value that may be poison cannot be proved where the function is called. A window gets preconditions when alive2 refuses it. They are what the `defined`, `ranges`, and `pointer` analyses know about its inputs just before it, as attributes, and they are tried together, so one that does not prove makes the attempt fail. A cut gets preconditions when it is made: `noundef` and the pointer facts as attributes, and as predicates the range bounds, the known bits and those its goal assumes. They are tried together, and when that is refused, the ones that hold when asked about alone are kept. ScalarEvolution adds linear relations among the values, such as `left == n - i`, but no other fact relating two, such as a multiplication that does not overflow.

## Loops and invariants

A goal that loops is cut at its first loop header and at the header the diff matched with it on the tgt side, which leaves one iteration whose back edge calls the induction hypothesis. A loop one side unrolled or peeled gets the other's iteration or outer unfolded to match its counters, as the `unfold` and `peel` scenarios do. A loop whose exit either side also enters from a guard before it, as after rotating or peeling, is cut at its exits first, as the `rotated` scenario does.

An iteration often holds only under an invariant, a fact that holds where the loop is entered and that each iteration keeps. `strengthen` proves a fact on a loop's callee at both places and assumes it at the iteration's start. The searcher finds invariants by Houdini when it cuts a loop at its header. The candidates are the analyses' facts at both headers, and also `noundef` on each of the callee's parameters, the comparisons `ne 0` and `sge 0` of each integer parameter, such as `key != 0` in the `strchr` scenario, and the comparisons (`ule`, `ult`, `sle`, `slt`, `eq`, `ne`) between two of its parameters of one integer type, such as `j <= i` in the `loop` scenario. Each round previews the strengthen, which asks about each candidate alone, and keeps the candidates that hold where the loop is entered and that one iteration keeps when all of those are assumed at its start. When a round drops nothing, what is left is inductive, and the searcher strengthens the cut with it. A loop that needs an invariant of another form, such as a relation that is not linear, stays open.
