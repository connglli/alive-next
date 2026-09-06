// run_list_rules: list the verified rewriter's rule names.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

export function createRulesTool(session: Session) {
  return defineTool({
    name: "run_list_rules",
    label: "List rules",
    description: "List the verified rewriter's rule names, which is what goal_rewrite offers.",
    parameters: Type.Object({}),
    execute: async () => {
      const rules = await session.rules();
      return toolResultFrom(
        session,
        true,
        `rules:\n${rules.map((rule) => `- ${rule}`).join("\n")}`,
        { rules },
      );
    },
  });
}
