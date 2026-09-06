// goal_rewrite: rewrite one side with the verified rewriter's named rules.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatEager, nameFor, toolResultFrom } from "./format.ts";

export function createRewriteTool(session: Session) {
  return defineTool({
    name: "goal_rewrite",
    label: "Rewrite",
    description:
      "Rewrite the src side of one goal with the verified rewriter's named rules, applied to fixpoint. Call `run_list_rules` to see what it offers. The rules' proofs certify the move, so no solver runs for the step itself. Input outside the rules passes through or refuses, and then the head does not move. The goal's new pair is then eagerly checked once on a small budget, so a rewrite that finishes a chain discharges the goal here.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal to rewrite." }),
      // TODO: Support tgt->src rewrites (some kind of anti-optimizations).
      rules: Type.Array(Type.String(), {
        minItems: 1,
        description: "Rule names from `run_list_rules`, applied to fixpoint.",
      }),
    }),
    execute: async (_id, { gid, rules }) => {
      const side = "src";
      const rewritten = await session.rewrite(gid, side, rules);
      if (rewritten.kind === "refused") {
        return toolResultFrom(
          session,
          false,
          `refused, ${rewritten.code}: ${rewritten.message}`,
          rewritten,
        );
      }
      if (rewritten.kind === "unchanged") {
        return toolResultFrom(session, false, "unchanged: no rule fired on this side", rewritten);
      }
      const eager = formatEager(rewritten.eager);
      return toolResultFrom(
        session,
        true,
        `rewrote ${gid} ${side} with ${rules.join(", ")}, head is ${nameFor(session, rewritten.hash)}${eager}`,
        rewritten,
      );
    },
  });
}
