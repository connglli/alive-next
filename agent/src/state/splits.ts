// Cutting a goal in two.
//
// Both sides are outlined at the cut the agent names: the prefix stays in an
// outer function that gains a call, the suffix becomes a fresh function, and
// the goal becomes two. The src side is cut first because its live-in set is
// the signature, and the tgt side is cut against that signature with the
// agent's value map.
//
// No solver runs here. A cut is a claim about where two programs line up, and
// what makes it hold is the two checks on the children afterwards: the outer
// pair with the callee left declared, which is where alive2's unknown-call
// semantics carries the state at the cut, and the callee pair on its own.
//
// A structural refusal is the useful kind. A tgt suffix that needs a value the
// map cannot cover means the cut points do not line up yet, which tells the
// agent to rewrite a side before cutting.
import type { Llops, OutlineParam } from "../drivers/llops.ts";
import type { Ref } from "../refs.ts";
import { type GoalId, head, nextGoalIds, type Tree } from "./goals.ts";
import type { Store } from "./store.ts";
import type { Effect } from "./trajectory.ts";

export type SplitResult =
  | {
      kind: "split";
      effects: Effect[];
      /** The signature both sides now share. */
      params: OutlineParam[];
      children: { outer: GoalId; callee: GoalId };
      /** The name the outlined function has in both modules. */
      callee: string;
    }
  | { kind: "refused"; side: "src" | "tgt"; code: string; message: string };

export class Splits {
  constructor(
    private readonly store: Store,
    private readonly llops: Llops,
  ) {}

  /**
   * Cut `gid` at `srcCut` on its src side and `tgtCut` on its tgt side, with
   * `valueMap` naming the tgt value that stands in for each src live value.
   */
  async split(
    tree: Tree,
    gid: string,
    srcCut: Ref,
    tgtCut: Ref,
    valueMap: Record<Ref, Ref>,
  ): Promise<SplitResult> {
    const goal = tree.goals.get(gid);
    if (!goal) throw new Error(`no goal ${gid}`);
    if (goal.status !== "open") throw new Error(`${gid} is ${goal.status}, not open`);

    const children = nextGoalIds(tree);
    // The outlined function is named after the callee goal, so the name is
    // fresh by construction and a reader can tell which cut made it.
    const callee = `outlined_${children.callee}`;

    const src = await this.llops.outlineSrc(this.store.get(head(goal, "src")), srcCut, callee);
    if (!src.ok) return { kind: "refused", side: "src", code: src.code, message: src.message };

    const tgt = await this.llops.outlineTgt(
      this.store.get(head(goal, "tgt")),
      tgtCut,
      callee,
      src.params,
      valueMap,
    );
    if (!tgt.ok) return { kind: "refused", side: "tgt", code: tgt.code, message: tgt.message };

    // Nothing is stored until both sides have been cut, so a refusal leaves
    // the store as it was.
    const [outerSrc, outerTgt, calleeSrc, calleeTgt] = await Promise.all([
      this.store.put(src.outer),
      this.store.put(tgt.outer),
      this.store.put(src.callee),
      this.store.put(tgt.callee),
    ]);

    return {
      kind: "split",
      params: src.params,
      children,
      callee,
      effects: [
        {
          effect: "split",
          gid,
          outer: { gid: children.outer, src: outerSrc, tgt: outerTgt },
          callee: { gid: children.callee, src: calleeSrc, tgt: calleeTgt },
        },
      ],
    };
  }

  /** Undo a cut, discarding the children and whatever was proved under them. */
  unsplit(tree: Tree, gid: string): Effect[] {
    const goal = tree.goals.get(gid);
    if (!goal) throw new Error(`no goal ${gid}`);
    if (goal.status !== "split") throw new Error(`${gid} is ${goal.status}, not split`);
    return [{ effect: "unsplit", gid }];
  }
}
