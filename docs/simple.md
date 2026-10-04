# The simple searcher

The simple searcher is a proof writer without a model. Like the agent, it is untrusted: it makes only the public moves of a session, so every step it takes is certified by alive2, every cut is rebuilt by llops, and its certificate is replayed by the kernel like any other. `bun run simple a.ll b.ll` runs it and writes the same session directory as the agent and the examples. `bun run simple --help` lists its options, and `engine/simple/limits.ts` holds their defaults.

## What it searches for

A proof has three parts, and the searcher searches for each: a rewrite path, the chain of certified steps that moves the src toward the tgt; cuts and their preconditions, which split a goal and say what each new function may assume about its inputs; and loops and their invariants, which prove a loop by induction over one iteration.

| Part | The framework allows | The searcher tries | It does not try |
| --- | --- | --- | --- |
| Rewrite path | steps on either side, by transactions or rules, and reverts | src steps through the optimizer's stages to the tgt, region by region | tgt steps, rules, reverts |
| Cuts and preconditions | cuts wherever both sides agree, with facts or predicates on the new parameters | a loop header, a region's boundaries, balanced points; the analyses' facts on the inputs of a window or a cut | predicates outside a loop, undoing a cut |
| Loops and invariants | cuts at a header or an exit, unfolding, invariants | the first header, where the diff matched one; invariants by Houdini | exit cuts, unfolding, invariants of other forms |

The searcher first checks the root's original pair on a short budget, and a proof or a refutation there ends the run. Otherwise it steps the root's src along a rewrite path and checks each goal: identical sides are proved at once, other sides are asked of alive2 on the default budget, and a pair that loops is never proved by a check. A goal that does not close is cut while cuts remain, and the goals a cut leaves are searched in the same way. A search that ends with open goals gives up and names them.

## Rewrite paths

An unoptimized src and its optimized tgt share few instructions, while consecutive stages of the optimizer share most of theirs. So the path runs through the optimizer's own stages: the searcher runs `default<O3>` on the src through `llops opt pipeline`, which keeps the program after each pass that changed it, and steps the src toward each stage before stepping it toward the tgt. A stage is only a hint: a step toward it that alive2 refuses is dropped, and the last stage need not equal the tgt.

A step toward a program goes region by region. The diff (`regions.ts`) matches the blocks of the two bodies by their contents and then the instructions inside each pair of matched blocks, each time as a longest common subsequence of `number`'s forms. Differences next to each other form a region. Regions are stepped from the last to the first, so that no step moves a region still to come.

A region becomes a step through the `splice` edit: a copy of the tgt's code replaces the region in the src. The copy reads the src partners of the values it reads, and the src's later uses read the partners of the values they used, both as the diff pairs them. The commit names the region as its window and does not ask the whole function. A region with one empty side, such as a deleted instruction, takes the shared instruction next to it, so that both windows hold something. A region with a phi or a terminator fits no window and is left to a cut.

When alive2 refuses a window, the searcher grows it backward over the instructions that define the values either side reads, and then tries it with preconditions. For a stage that its windows leave unfinished, it tries one step of the whole function to that stage, which the framework refuses for a program that loops.

Every step is on the src side, since putting the tgt's region into the src asks alive2 about the same two windows as putting the src's region into the tgt. The searcher applies none of the verified rewriter's rules, because a rule rewrites wherever it matches rather than toward the program a step aims at. It keeps every step alive2 certifies and reverts none.

## Cuts and preconditions

A goal that does not close is cut at the first of these that the framework accepts:

* Its first loop header, as the next section says.
* Around the first region its steps left, whether no window could hold the region or alive2 refused its windows. The goal is cut after the region and then at its head, or at its block when it starts with a phi, so that the region stands in a goal of its own. That goal is not cut around a region again.
* Where both sides agree and its multiplications, divisions, remainders, loads, and stores split most evenly between the two halves, trying the three most even points. Calls do not count, since every cut adds one.

A cut passes each value that crosses it as the tgt value the diff matched with it, and a value without a match makes the cut fail. The searcher never undoes a cut: a goal that a check refutes is cut further, like a goal the check does not decide.

A window is outlined as a cut is, and both can carry preconditions: facts about the new function's inputs, proved where it is called and assumed inside it. A window gets them when alive2 refuses it, and a cut gets them as soon as it is made, except that a cut at a loop header gets invariants, as the next section says. They are what the `defined`, `ranges`, and `pointer` analyses know about the inputs just before the window or the cut, as attributes. Only inputs the analyses find `noundef` get facts, since a fact about a value that may be poison cannot be proved where the function is called. The facts are tried together, and one that does not prove makes the whole attempt fail. The analyses give facts about single values, so outside a loop the searcher states no fact relating two values, such as a multiplication that does not overflow.

## Loops and invariants

A goal that loops is cut at its first loop header and at the header the diff matched with it on the tgt side, which leaves one iteration whose back edge calls the induction hypothesis. Two kinds of loop are not cut, since the searcher neither cuts an exit first nor unfolds. A loop with different shapes on the two sides, such as one only the tgt rotated, has no matched header; the `unfold` and `peel` scenarios prove such loops by unfolding one side. A loop that both sides rotated has an exit also entered from the guard before it, and the framework detaches its header only after its exit, as the `rotated` scenario does.

An iteration often holds only under an invariant, a fact that holds where the loop is entered and that each iteration keeps. `strengthen` proves a fact on a loop's callee at both places and assumes it at the iteration's start. The searcher finds invariants by Houdini when it cuts a loop at its header. The candidates are `noundef` on each of the callee's parameters, the comparisons `ne 0` and `sge 0` of each integer parameter, such as `key != 0` in the `strchr` scenario, and the comparisons (`ule`, `ult`, `sle`, `slt`, `eq`, `ne`) between two of its parameters of one integer type, such as `j <= i` in the `loop` scenario. Each round previews the strengthen, which asks about each candidate alone, and keeps the candidates that hold where the loop is entered and that one iteration keeps when all of those are assumed at its start. When a round drops nothing, what is left is inductive, and the searcher strengthens the cut with it. A loop that needs an invariant of another form, such as an offset between two values or a relation among three, stays open.
