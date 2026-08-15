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
import { type GoalId, head, nextGoalIds, type Tree, workable } from "./goals.ts";
import type { Store } from "./store.ts";
import type { Effect } from "./trajectory.ts";

export type SplitPreviewResult =
  | {
      kind: "preview";
      /** The signature both sides share if cut. */
      params: OutlineParam[];
      callee: string;
      /** Outlined programs if value_map was provided and valid. */
      programs?: {
        outerSrc: string;
        outerTgt: string;
        calleeSrc: string;
        calleeTgt: string;
      };
    }
  | { kind: "refused"; side: "src" | "tgt"; code: string; message: string };

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
  /** A structural refusal from llops while outlining one side. */
  | { kind: "refused"; side: "src" | "tgt"; code: string; message: string };

export class Splits {
  constructor(
    private readonly store: Store,
    private readonly llops: Llops,
  ) {}

  /**
   * Preview cutting `gid` at `srcCut` on its src side and `tgtCut` on its tgt side.
   * If `valueMap` is omitted, computes and returns the src live-in signature.
   * If `valueMap` is provided, validates that the tgt suffix lines up with that signature.
   */
  async preview(
    tree: Tree,
    gid: string,
    srcCut: Ref,
    tgtCut: Ref,
    valueMap?: Record<Ref, Ref>,
  ): Promise<SplitPreviewResult> {
    const goal = workable(tree, gid);

    const children = nextGoalIds(tree);
    // The outlined function is named after the callee goal, so the name is
    // fresh by construction and a reader can tell which cut made it.
    const callee = `outlined_${children.callee}`;

    const src = await this.llops.outlineSrc(this.store.get(head(goal, "src")), srcCut, callee);
    if (!src.ok) return { kind: "refused", side: "src", code: src.code, message: src.message };

    if (!valueMap) {
      return { kind: "preview", params: src.params, callee };
    }

    const tgt = await this.llops.outlineTgt(
      this.store.get(head(goal, "tgt")),
      tgtCut,
      callee,
      src.params,
      valueMap,
    );
    if (!tgt.ok) return { kind: "refused", side: "tgt", code: tgt.code, message: tgt.message };

    return {
      kind: "preview",
      params: src.params,
      callee,
      programs: {
        outerSrc: src.outer,
        outerTgt: tgt.outer,
        calleeSrc: src.callee,
        calleeTgt: tgt.callee,
      },
    };
  }

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
    const preview = await this.preview(tree, gid, srcCut, tgtCut, valueMap);
    if (preview.kind === "refused") return preview;
    if (!preview.programs) {
      return {
        kind: "refused",
        side: "tgt",
        code: "missing_programs",
        message: "split preview produced no programs",
      };
    }

    const children = nextGoalIds(tree);
    const callee = preview.callee;

    const { outerSrc, outerTgt, calleeSrc, calleeTgt } = preview.programs;
    const [outerSrcHash, outerTgtHash, calleeSrcHash, calleeTgtHash] = await Promise.all([
      this.store.put(outerSrc),
      this.store.put(outerTgt),
      this.store.put(calleeSrc),
      this.store.put(calleeTgt),
    ]);

    return {
      kind: "split",
      params: preview.params,
      children,
      callee,
      effects: [
        {
          effect: "split",
          gid,
          name: callee,
          outer: { gid: children.outer, src: outerSrcHash, tgt: outerTgtHash },
          callee: { gid: children.callee, src: calleeSrcHash, tgt: calleeTgtHash },
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
