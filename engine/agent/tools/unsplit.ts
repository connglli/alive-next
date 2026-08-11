// tree_unsplit: undo a cut, discarding both halves.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

export function createUnsplitTool(session: Session) {
  return defineTool({
    name: "tree_unsplit",
    label: "Unsplit",
    description:
      "Undo a cut. Both children and everything under them are discarded and the goal is open again, which is what to do when a callee cannot be proved because the cut is in the wrong place.",
    parameters: Type.Object({ gid: Type.String({ description: "The goal that was cut." }) }),
    execute: async (_id, { gid }) => {
      const undone = await session.unsplit(gid);
      return toolResultFrom(session, true, `${gid} is open again`, undone);
    },
  });
}
