// tree_uninterpose: undo an interpose, discarding both halves.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

export function createUninterposeTool(session: Session) {
  return defineTool({
    name: "tree_uninterpose",
    label: "Uninterpose",
    description:
      "Undo tree_interpose: discard both children and everything under them, and reopen the goal.",
    parameters: Type.Object({ gid: Type.String({ description: "The goal that was interposed." }) }),
    execute: async (_id, { gid }) => {
      const undone = await session.uninterpose(gid);
      if (undone.kind === "editing") {
        return toolResultFrom(session, false, `refused: ${undone.message}`, undone);
      }
      return toolResultFrom(session, true, `${gid} is open again`, undone);
    },
  });
}
