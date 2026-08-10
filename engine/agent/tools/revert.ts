// revert: move a side's head back to a program it has been.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { answer, answerFrom } from "./format.ts";

export function revertTool(session: Session) {
  return defineTool({
    name: "revert",
    label: "Revert",
    description:
      "Put one side of a goal back to a program it held earlier, which show lists for each side. The steps after it are abandoned, and whatever proof they carried comes undone with them. This is how a path that led nowhere is left.",
    parameters: Type.Object({
      gid: Type.String(),
      side: Type.Union([Type.Literal("src"), Type.Literal("tgt")]),
      to: Type.String({ description: "A program id such as p3, from that side's history." }),
    }),
    execute: async (_id, { gid, side, to }) => {
      const reverted = await session.revert(gid, side, to);
      if (reverted.kind === "refused") {
        return answer(false, `refused: ${reverted.message}`, reverted);
      }
      return answerFrom(session, true, `${gid} ${side} is ${reverted.to.id} again`, reverted);
    },
  });
}
