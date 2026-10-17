// tree_uncase: undo a proof by cases, discarding both cases.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

export function createUncaseTool(session: Session) {
  return defineTool({
    name: "tree_uncase",
    label: "Uncase",
    description:
      "Undo tree_case: discard both cases and everything under them, and reopen the goal.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal that was split by cases." }),
    }),
    execute: async (_id, { gid }) => {
      const undone = await session.uncase(gid);
      if (undone.kind === "editing") {
        return toolResultFrom(session, false, `refused: ${undone.message}`, undone);
      }
      return toolResultFrom(session, true, `${gid} is open again`, undone);
    },
  });
}
