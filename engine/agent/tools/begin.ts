// begin: open a transaction on one side of one goal.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatProgram, nameFor, toolResult } from "./format.ts";

export function createBeginTool(session: Session) {
  return defineTool({
    name: "begin",
    label: "Begin",
    description:
      "Start editing one side of one goal. The edits that follow are scratch and cost no solver time; commit certifies the whole of them as one step, abort throws them away. One transaction at a time. Answers with the body you are editing, which is what the edits address.",
    parameters: Type.Object({
      gid: Type.String(),
      side: Type.Union([Type.Literal("src"), Type.Literal("tgt")]),
    }),
    execute: async (_id, { gid, side }) => {
      const opened = await session.begin(gid, side);
      return toolResult(
        true,
        formatProgram(`editing ${gid} ${side}, from ${nameFor(session, opened.from)}`, opened.text),
        { gid, side, from: opened.from },
      );
    },
  });
}
