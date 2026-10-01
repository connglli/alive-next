import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatBudgets, formatEdits, formatGoalTree, formatSection, toolResult } from "./format.ts";

export function createStatusTool(session: Session) {
  return defineTool({
    name: "run_status",
    label: "Status",
    description:
      "The goal tree: every goal, whether it is open, split, proved or refuted, and the two programs it holds, followed by the budget of each query. Names no program text, so it is the cheap thing to call before deciding what to do next.",
    parameters: Type.Object({}),
    execute: async () => {
      const standing = await session.status();
      const editing = standing.editing
        ? `\nediting: ${standing.editing.gid} ${standing.editing.side}, ${formatEdits(standing.editing.ops)} so far`
        : "";
      return toolResult(
        true,
        [
          formatSection("Goal tree", formatGoalTree(session, standing.goals)),
          formatSection(
            "Run",
            `verdict: ${standing.verdict}${editing}\n${formatBudgets(standing.budgets)}`,
          ),
        ].join("\n\n"),
        standing,
      );
    },
  });
}
