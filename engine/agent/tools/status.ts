// run_status: where the run stands.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatAssumption, formatBudgets, formatGoalTree, toolResult } from "./format.ts";

export function createStatusTool(session: Session) {
  return defineTool({
    name: "run_status",
    label: "Status",
    description:
      "The goal tree: every goal, whether it is open, split, proved or refuted, and the two programs it holds, followed by what a check and a commit may spend and what the run assumes about the pair's arguments. Names no program text, so it is the cheap thing to call before deciding what to do next.",
    parameters: Type.Object({}),
    execute: async () => {
      const standing = await session.status();
      const editing = standing.editing
        ? `\nediting ${standing.editing.gid} ${standing.editing.side}, ${standing.editing.ops} ops so far`
        : "";
      return toolResult(
        true,
        [
          formatGoalTree(session, standing.goals),
          `verdict ${standing.verdict}${editing}`,
          formatBudgets(standing.budgets),
          formatAssumption(standing.assumed),
        ].join("\n"),
        standing,
      );
    },
  });
}
