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
      "Rewrite one side of one goal with the verified rewriter's named rules, applied to fixpoint. The rules' proofs certify the move, so no solver runs for the step itself. Only integer arithmetic and bitwise peepholes; anything else passes through or refuses, and then the head does not move. The goal's new pair is then eagerly checked once on a small budget, so a rewrite that finishes a chain discharges the goal here.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal to rewrite a side of." }),
      side: Type.Union([Type.Literal("src"), Type.Literal("tgt")]),
      rules: Type.Array(Type.String(), {
        description: "Rule names from `run_list_rules`, applied to fixpoint.",
      }),
      timeout_ms: Type.Optional(
        Type.Integer({
          description: "Rewriter budget for this call. Spending it is your decision.",
        }),
      ),
    }),
    execute: async (_id, { gid, side, rules, timeout_ms }) => {
      const rewritten = await session.rewrite(gid, side, rules, timeout_ms);
      if (rewritten.kind === "refused") {
        return toolResultFrom(
          session,
          false,
          `refused (${rewritten.code}): ${rewritten.message}; rewrite by hand with tx_begin, tx_edit and tx_commit instead`,
          rewritten,
        );
      }
      if (rewritten.kind === "unchanged") {
        return toolResultFrom(
          session,
          false,
          "unchanged: no rule fired on this side; name other rules or rewrite by hand with tx_begin, tx_edit and tx_commit",
          rewritten,
        );
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
