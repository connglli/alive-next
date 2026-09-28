// tree_split_preview: preview cutting a goal in two without modifying the tree.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

export function createSplitPreviewTool(session: Session) {
  return defineTool({
    name: "tree_split_preview",
    label: "Split Preview",
    description:
      "Preview tree_split at an instruction (`%N` or `#N`) or a block (`%bbN`) on each side without changing the goal tree. Without value_map, it answers with the src values that would cross the cut; with one, it says whether the tgt side lines up with them.",
    parameters: Type.Object({
      gid: Type.String(),
      src_cut: Type.String({
        description: "The src instruction (`%N` or `#N`) or block (`%bbN`) the cut is made at.",
      }),
      tgt_cut: Type.String({
        description: "The tgt instruction (`%N` or `#N`) or block (`%bbN`) the cut is made at.",
      }),
      value_map: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            'Optional. Map from each src live-in value (key) to the corresponding tgt value (value) crossing the cut, such as { "%3": "%5" }.',
        }),
      ),
    }),
    execute: async (_id, { gid, src_cut, tgt_cut, value_map }) => {
      const preview = await session.splitPreview(gid, src_cut, tgt_cut, value_map);
      if (preview.kind === "refused") {
        return toolResultFrom(
          session,
          false,
          `refused, ${preview.code}: ${preview.message}`,
          preview,
        );
      }
      const params = preview.params
        .map((param, at) => `  ${at}: ${param.param} ${param.type}, the src's ${param.live}`)
        .join("\n");

      const lines = [
        `Preview of cut on ${gid} at src ${src_cut}, tgt ${tgt_cut}:`,
        `outlined function signature: @${preview.callee}`,
        `parameters:\n${params}`,
      ];

      if (value_map) {
        lines.push(
          "value_map is valid. Both sides outline cleanly. Call tree_split with these arguments to apply the cut.",
        );
      } else {
        lines.push(
          'Provide value_map: { "<src_value>": "<tgt_value>", ... } covering all live values when calling tree_split.',
        );
      }

      return toolResultFrom(session, true, lines.join("\n\n"), preview);
    },
  });
}
