// tree_split: cut a goal in two at aligned points.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

export function createSplitTool(session: Session) {
  return defineTool({
    name: "tree_split",
    label: "Split",
    description:
      "Cut a goal at an instruction or a block on each side, making an outer goal that calls a fresh function and a callee goal that is its body. At an instruction (`%N`, or `#N` for the instruction marked `; #N`, which also names one defining no value, such as a store), the callee is the rest of the body from it. At a block (`%bbN`), it is the block and every block it reaches, and each branch to the block becomes a call; a loop's back edge calls the hypothesis the result names instead, a declaration standing for the callee. value_map pairs each src value crossing the cut with the tgt value standing for it. To pass a tgt value that has no src counterpart, add it under a key that is not a src value; the src passes `poison` for it. Callee parameters may be `poison` until tree_strengthen proves them `noundef`, so a cut is usually followed by one.",
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
      const params = split.params
        .map((param, at) => `  ${at}: ${param.param} ${param.type}, the src's ${param.live}`)
        .join("\n");
      return toolResultFrom(
        session,
        true,
        [
          `${gid} is cut into @${split.callee}`,
          `outer ${split.children.outer}, callee ${split.children.callee}`,
          ...(split.detach?.hypothesis ? [`back edges call @${split.detach.hypothesis}`] : []),
          `parameters:\n${params}`,
        ].join("\n"),
        split,
      );
    },
  });
}
