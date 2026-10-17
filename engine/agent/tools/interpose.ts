// tree_interpose: prove a goal through the program the open transaction made.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { nameFor, toolResultFrom } from "./format.ts";

export function createInterposeTool(session: Session) {
  return defineTool({
    name: "tree_interpose",
    label: "Interpose",
    description:
      "Put the program the open transaction made between the goal's two sides, turning the goal into lhs (its src and the program) and rhs (the program and its tgt), which prove it together. The transaction closes.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal the open transaction is editing a side of." }),
    }),
    execute: async (_id, { gid }) => {
      const made = await session.interpose(gid);
      if (made.kind !== "interposed") {
        return toolResultFrom(session, false, `refused: ${made.message}`, made);
      }
      const { lhs, rhs } = made.children;
      const through = nameFor(session, made.program);
      return toolResultFrom(
        session,
        true,
        `${gid} is interposed through ${through}: lhs ${lhs}, rhs ${rhs}`,
        made,
      );
    },
  });
}
