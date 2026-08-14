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
      "Preview cutting a goal at a value on each side without modifying the goal tree. If value_map is omitted, discovers and returns the src live-in parameters required across the cut. If value_map is provided, validates whether the tgt suffix lines up cleanly with the signature.",
    parameters: Type.Object({
      gid: Type.String(),
      src_cut: Type.String({ description: "The src value the suffix starts at." }),
      tgt_cut: Type.String({ description: "The tgt value the suffix starts at." }),
      value_map: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Optional. Each tgt value crossing the cut, to the src value it stands for.",
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
          'Provide value_map: { "<tgt_value>": "<src_value>", ... } covering all live values when calling tree_split.',
        );
      }

      return toolResultFrom(session, true, lines.join("\n\n"), preview);
    },
  });
}
