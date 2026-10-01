// tree_split_preview: preview cutting a goal in two without modifying the tree.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatSection, toolResultFrom } from "./format.ts";

export function createSplitPreviewTool(session: Session) {
  return defineTool({
    name: "tree_split_preview",
    label: "Split Preview",
    description:
      "Preview tree_split at an instruction (`%N` or `#N`) or a block (`%bbN`) on each side without changing the goal tree. Without value_map, it answers with the values that would cross the cut on each side; with one, it says whether the tgt side lines up with the src's.",
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
        return toolResultFrom(session, false, `refused: ${preview.message}`, preview);
      }
      const params = preview.params
        .map((param, at) => `  ${at}: ${param.param} ${param.type}, the src's ${param.live}`)
        .join("\n");

      const cutting = `cutting ${gid} at src ${src_cut} and tgt ${tgt_cut} would make @${preview.callee}`;
      if (value_map) {
        const valid = "The value_map is valid: tree_split with the same arguments makes this cut.";
        return toolResultFrom(session, true, `${cutting}\n${valid}`, preview, [
          formatSection("Parameters", params),
        ]);
      }
      const tgt = (preview.tgtParams ?? []).map((param) => `  ${param.live} ${param.type}`);
      const needs =
        'tree_split needs a value_map from each src value below to a tgt value, as { "<src_value>": "<tgt_value>" }.';
      return toolResultFrom(session, true, `${cutting}\n${needs}`, preview, [
        formatSection("Parameters", params),
        formatSection("tgt values at its cut", tgt.join("\n")),
      ]);
    },
  });
}
