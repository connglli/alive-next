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
      'Cut a goal at a value on each side, making an outer goal that calls an outlined function and a callee goal that is its body. The value_map assigns a tgt value to each src live-in value crossing the cut: {"<src_value>": "<tgt_value>"}. The callee\'s parameters are undef-capable until tree_strengthen says otherwise, so a cut is usually followed by one.',
    parameters: Type.Object({
      gid: Type.String(),
      src_cut: Type.String({ description: "The src value the suffix starts at." }),
      tgt_cut: Type.String({ description: "The tgt value the suffix starts at." }),
      value_map: Type.Record(Type.String(), Type.String(), {
        description:
          'Map from each src live-in value (key) to the corresponding tgt value (value) crossing the cut, formatted as { "<src_value>": "<tgt_value>" }.',
      }),
    }),
    execute: async (_id, { gid, src_cut, tgt_cut, value_map }) => {
      const split = await session.split(gid, src_cut, tgt_cut, value_map);
      if (split.kind === "refused") {
        return toolResultFrom(session, false, `refused, ${split.code}: ${split.message}`, split);
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
          `parameters:\n${params}`,
        ].join("\n"),
        split,
      );
    },
  });
}
