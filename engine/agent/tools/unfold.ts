// goal_unfold: run a detached loop's body twice for each call of its hypothesis.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatEager, nameFor, toolResultFrom } from "./format.ts";

export function createUnfoldTool(session: Session) {
  return defineTool({
    name: "goal_unfold",
    label: "Unfold",
    description:
      "On the callee goal of a loop cut at its header, put the loop's body at each call of its hypothesis on one side, so that one call runs two iterations. Use it when the other side's loop runs two iterations each time this side's runs one, as a loop unrolled by two does. Unfold before `tree_strengthen`, because a fact such as `i` being even may hold only every second iteration. No solver runs for the step itself, and the goal's new pair is then eagerly checked once on a small budget.",
    parameters: Type.Object({
      gid: Type.String({ description: "The callee goal of a loop cut at its header." }),
      side: Type.Union([Type.Literal("src"), Type.Literal("tgt")]),
    }),
    execute: async (_id, { gid, side }) => {
      const unfolded = await session.unfold(gid, side);
      if (unfolded.kind === "refused") {
        return toolResultFrom(
          session,
          false,
          `refused, ${unfolded.code}: ${unfolded.message}`,
          unfolded,
        );
      }
      const eager = formatEager(unfolded.eager);
      return toolResultFrom(
        session,
        true,
        `unfolded ${gid} ${side}, head is ${nameFor(session, unfolded.hash)}${eager}`,
        unfolded,
      );
    },
  });
}
