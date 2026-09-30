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
      "Put a loop's body at its calls on one side of a loop cut at its header. In the callee goal, one call then runs two iterations, to pair with a loop unrolled by two. In the outer goal, the outer then runs the first iteration, to pair with a peeled loop. Unfold before `tree_strengthen`. No solver runs for the step itself.",
    parameters: Type.Object({
      gid: Type.String({
        description: "The outer or the callee goal of a loop cut at its header.",
      }),
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
