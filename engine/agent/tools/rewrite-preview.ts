// goal_rewrite_preview: what the verified rewriter's rules would make of one side.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatProgram, toolResultFrom } from "./format.ts";

export function createRewritePreviewTool(session: Session) {
  return defineTool({
    name: "goal_rewrite_preview",
    label: "Rewrite Preview",
    description:
      "Show what goal_rewrite's rules would make of either side of a goal, without changing it.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal whose side to preview." }),
      side: Type.Optional(Type.Union([Type.Literal("src"), Type.Literal("tgt")])),
      rules: Type.Array(Type.String(), {
        minItems: 1,
        description: "Rule names from `run_list_rules`.",
      }),
    }),
    execute: async (_id, { gid, side = "src", rules }) => {
      const preview = await session.rewritePreview(gid, side, rules);
      if (preview.kind === "refused") {
        return toolResultFrom(session, false, `refused: ${preview.message}`, preview);
      }
      if (!preview.changed) {
        const unchanged = `no rule fires on ${gid} ${side}, so goal_rewrite would leave it as it is`;
        return toolResultFrom(session, true, unchanged, preview);
      }
      return toolResultFrom(
        session,
        true,
        `rewriting ${gid} ${side} with ${rules.join(", ")} would make this program`,
        preview,
        [formatProgram("Rewritten program", await session.number(preview.program))],
      );
    },
  });
}
