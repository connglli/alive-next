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
//
// A cut that names a block detaches it: the block and every block it reaches
// become the callee, each branch to it a call, and a back edge a call of the
// hypothesis, the declaration `llops detach` makes to stand for the callee.
import type { DetachResult, Llops, LlopsResult, OutlineParam } from "../drivers/llops.ts";
import type { Ref } from "../refs.ts";
import { type GoalId, head, nextGoalIds, type Tree, workable } from "./goals.ts";
import type { Store } from "./store.ts";
import type { Detach, Effect } from "./trajectory.ts";

export type SplitPreviewResult =
  | {
      kind: "preview";
      /** The signature both sides share if cut. */
      params: OutlineParam[];
      /** The tgt's own values at its cut, which a value_map pairs the src's with. */
      tgtParams?: OutlineParam[];
      callee: string;
      /** Present when the cut detaches a block and value_map was provided. */
      detach?: Detach;
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
      /** Present when the cut detached a block. */
      detach?: Detach;
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
   * If `valueMap` is omitted, computes the src live-in signature and the tgt's own live-ins.
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

    const srcModule = this.store.get(head(goal, "src"));
    const tgtModule = this.store.get(head(goal, "tgt"));
    const atBlock = namesBlock(srcCut, srcModule);
    if (atBlock !== namesBlock(tgtCut, tgtModule)) {
      const message = "both cuts name a block, or neither does";
      return { kind: "refused", side: "tgt", code: "invalid", message };
    }
    const cutAlone = (module: string, cut: Ref, params?: OutlineParam[]) =>
      atBlock
        ? this.llops.detachSrc(module, cut, callee, params)
        : this.llops.outlineSrc(module, cut, callee, params);
    const cutSrc = (params?: OutlineParam[]): Promise<LlopsResult<DetachResult>> =>
      cutAlone(srcModule, srcCut, params);
    const first = await cutSrc();
    if (!first.ok)
      return { kind: "refused", side: "src", code: first.code, message: first.message };

    if (!valueMap) {
      const own = await cutAlone(tgtModule, tgtCut);
      if (!own.ok) return { kind: "refused", side: "tgt", code: own.code, message: own.message };
      return { kind: "preview", params: first.params, tgtParams: own.params, callee };
    }

    const tgt: LlopsResult<DetachResult> = atBlock
      ? await this.llops.detachTgt(tgtModule, tgtCut, callee, first.params, valueMap)
      : await this.llops.outlineTgt(tgtModule, tgtCut, callee, first.params, valueMap);
    if (!tgt.ok) return { kind: "refused", side: "tgt", code: tgt.code, message: tgt.message };
    // The tgt added values the src lacks, so cut the src again with the longer signature.
    const src = tgt.params.length > first.params.length ? await cutSrc(tgt.params) : first;
    if (!src.ok) return { kind: "refused", side: "src", code: src.code, message: src.message };
    // Induction needs the hypothesis on both sides, so a block has to head a
    // loop on both or on neither.
    if (src.hypothesis !== tgt.hypothesis) {
      const message = "the block heads a loop on one side only";
      return { kind: "refused", side: "tgt", code: "invalid", message };
    }
    // A checker rebuilds each side from its halves, so a cut that does not
    // rebuild is refused now rather than at replay.
    for (const [side, half, whole] of [
      ["src", src, srcModule],
      ["tgt", tgt, tgtModule],
    ] as const) {
      const message = await this.unbuilt(half, whole, callee, atBlock);
      if (message) return { kind: "refused", side, code: "invalid", message };
    }

    return {
      kind: "preview",
      params: src.params,
      callee,
      ...(atBlock ? { detach: detachOf(src, tgt) } : {}),
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
      ...(preview.detach ? { detach: preview.detach } : {}),
      effects: [
        {
          effect: "split",
          gid,
          name: callee,
          outer: { gid: children.outer, src: outerSrcHash, tgt: outerTgtHash },
          callee: { gid: children.callee, src: calleeSrcHash, tgt: calleeTgtHash },
          ...(preview.detach ? { detach: preview.detach } : {}),
        },
      ],
    };
  }

  /** Why the halves do not put back together as `whole`, or nothing when they do. */
  private async unbuilt(
    half: DetachResult,
    whole: string,
    callee: string,
    detached: boolean,
  ): Promise<string | undefined> {
    const back = detached
      ? await this.llops.reattach(half.outer, half.callee, callee, half.phis ?? [], half.hypothesis)
      : await this.llops.inline(half.outer, half.callee, callee);
    if (!back.ok) return `the halves do not go back together: ${back.message}`;
    const same = await this.llops.canon(back.module);
    if (!same.ok || same.module !== whole) return "the halves go back together as another program";
    return undefined;
  }

  /** Undo a cut, discarding the children and whatever was proved under them. */
  unsplit(tree: Tree, gid: string): Effect[] {
    const goal = tree.goals.get(gid);
    if (!goal) throw new Error(`no goal ${gid}`);
    if (goal.status !== "split") throw new Error(`${gid} is ${goal.status}, not split`);
    return [{ effect: "unsplit", gid }];
  }
}

/** What a block cut records: each side's phis, and the hypothesis when it heads a loop. */
function detachOf(src: DetachResult, tgt: DetachResult): Detach {
  const phis = { src: src.phis ?? [], tgt: tgt.phis ?? [] };
  return src.hypothesis ? { phis, hypothesis: src.hypothesis } : { phis };
}

/** Whether a reference names one of the module's blocks, whose label starts a line. */
function namesBlock(ref: Ref, module: string): boolean {
  const label = `${ref.trim().replace(/^%/, "")}:`;
  return module.split("\n").some((line) => line.startsWith(label));
}
