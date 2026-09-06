// run_list_rules: list the verified rewriter's rule names and patterns.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

export function createRulesTool(session: Session) {
  return defineTool({
    name: "run_list_rules",
    label: "List rules",
    description:
      "List the verified rewriter's rule names and patterns, which is what goal_rewrite offers.",
    parameters: Type.Object({}),
    execute: async () => {
      const rules = await session.rules();
      const lines = rules.map((rule) =>
        rule.pattern ? `- name: ${rule.name}; pattern: ${rule.pattern}.` : `- name: ${rule.name}.`,
      );
      return toolResultFrom(session, true, `rules:\n${lines.join("\n")}`, { rules });
    },
  });
}
