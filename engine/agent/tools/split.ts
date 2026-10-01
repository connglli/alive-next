// tree_split: cut a goal in two at aligned points.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatParams, toolResultFrom } from "./format.ts";

export function createSplitTool(session: Session) {
  return defineTool({
    name: "tree_split",
    label: "Split",
    description:
      "Cut a goal on each side at an instruction or a block, into an outer goal calling a fresh function and a callee goal holding its body. At an instruction (`%N`, or `#N` for one marked `; #N`, even a store), the callee is the rest of the body. At a block (`%bbN`), it is the block and all it reaches; each branch to the block becomes a call, and a loop's back edge calls the hypothesis that stands for the callee. value_map pairs each src value crossing the cut with its tgt value. A tgt value with no src counterpart goes under a key that is not a src value, and the src passes `poison` for it, since every value refines `poison`, while only 0 refines 0. No fact about that parameter holds until the src passes a real value. Any callee parameter may be `poison` until tree_strengthen proves it `noundef`, so a cut is usually followed by one.",
    parameters: Type.Object({
      gid: Type.String(),
      src_cut: Type.String({
        description: "The src instruction (`%N` or `#N`) or block (`%bbN`) the cut is made at.",
      }),
      tgt_cut: Type.String({
        description: "The tgt instruction (`%N` or `#N`) or block (`%bbN`) the cut is made at.",
      }),
      value_map: Type.Record(Type.String(), Type.String(), {
        description:
          'Map from each src live-in value (key) to the corresponding tgt value (value) crossing the cut, such as { "%3": "%5" }.',
      }),
    }),
    execute: async (_id, { gid, src_cut, tgt_cut, value_map }) => {
      const split = await session.split(gid, src_cut, tgt_cut, value_map);
      if (split.kind === "editing") {
        return toolResultFrom(session, false, `refused: ${split.message}`, split);
      }
      if (split.kind === "refused") {
        return toolResultFrom(session, false, `refused: ${split.message}`, split);
      }
      return toolResultFrom(
        session,
        true,
        [
          `${gid} is cut into @${split.callee}`,
          `outer ${split.children.outer}, callee ${split.children.callee}`,
          ...(split.detach?.hypothesis ? [`back edges call @${split.detach.hypothesis}`] : []),
        ].join("\n"),
        split,
        [formatParams(split.params, split.detach?.hypothesis)],
      );
    },
  });
}
