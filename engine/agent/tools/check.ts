// goal_check: ask alive2 whether a goal's claim holds as it stands.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

export function createCheckTool(session: Session) {
  return defineTool({
    name: "goal_check",
    label: "Check",
    description:
      "Ask whether a goal's tgt refines its src as the two stand. Proved discharges the goal. Refuted is a hint about this pair and not about the translation, since a valid step can overshoot and a callee's entry is conservative. Unknown means the solver ran out of time.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal to check." }),
      timeout_ms: Type.Optional(
        Type.Integer({ description: "Solver budget for this call. Spending it is your decision." }),
      ),
    }),
    execute: async (_id, { gid, timeout_ms }) => {
      const checked = await session.check(gid, timeout_ms);
      const detail = checked.check.detail ? `\n${checked.check.detail}` : "";
      // What it ran on, because a timeout means nothing without the budget it
      // ran out of, and asking for more than the cap is answered by the cap.
      const budgetMs = checked.check.invocation.timeoutMs;
      const budget = checked.cappedFromMs
        ? `${budgetMs}ms budget, capped from the ${checked.cappedFromMs}ms asked for`
        : `${budgetMs}ms budget`;
      // Proved is the only outcome that advanced the run; a refutation is a
      // hint and a timeout is nothing at all.
      return toolResultFrom(
        session,
        checked.outcome === "proved",
        `${gid} ${checked.outcome}, ${budget}${detail}`,
        checked,
      );
    },
  });
}
