// status: where the run stands.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { answer, goalTree } from "./format.ts";

export function statusTool(session: Session) {
  return defineTool({
    name: "status",
    label: "Status",
    description:
      "The goal tree: every goal, whether it is open, split, proved or refuted, and the two programs it holds. Names no program text, so it is the cheap thing to call before deciding what to do next.",
    parameters: Type.Object({}),
    execute: async () => {
      const standing = await session.status();
      const editing = standing.editing
        ? `\nediting ${standing.editing.gid} ${standing.editing.side}, ${standing.editing.ops} ops so far`
        : "";
      return answer(
        true,
        `${goalTree(session, standing.goals)}\nverdict ${standing.verdict}${editing}`,
        standing,
      );
    },
  });
}
