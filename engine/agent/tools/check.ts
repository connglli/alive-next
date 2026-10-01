// goal_check: ask alive2 whether a goal's claim holds as it stands.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import type { CheckGoalResult } from "../../core/state/steps.ts";
import { toolResultFrom } from "./format.ts";

/** A goal's outcome in the words the other answers use. */
function said(outcome: CheckGoalResult["outcome"]): string {
  return outcome === "unknown" ? "not settled" : outcome;
}

export function createCheckTool(session: Session) {
  return defineTool({
    name: "goal_check",
    label: "Check",
    description:
      "Ask whether a goal's tgt refines its src as the two stand. Proved discharges the goal. Refuted ends the run only when this goal is the root checked against its original pair; elsewhere it is a hint, since a valid step can overshoot and a callee's entry is conservative. A pair that loops is proved by tree_split at its loop header; `unroll` only searches it for a counterexample, whose input run_report_cex certifies.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal to check." }),
      timeout_ms: Type.Optional(
        Type.Integer({
          description: "How long the solver may run, in ms, up to the cap run_status shows.",
        }),
      ),
      unroll: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "For a pair that loops: how many iterations to search.",
        }),
      ),
    }),
    execute: async (_id, { gid, timeout_ms, unroll }) => {
      const checked = await session.check(gid, timeout_ms, unroll);
      const detail = checked.check.detail ? `\n${checked.check.detail}` : "";
      // What it ran on, because a timeout means nothing without the budget it
      // ran out of, and asking for more than the cap is answered by the cap.
      const budgetMs = checked.check.invocation.timeoutMs;
      const budget = checked.cappedFromMs
        ? `${budgetMs}ms budget, capped from the ${checked.cappedFromMs}ms asked for`
        : `${budgetMs}ms budget`;
      const prior = checked.prior
        ? `earlier check: ${said(checked.prior.outcome)} on a ${checked.prior.budgetMs}ms budget; `
        : "";
      // Proved is the only outcome that advanced the run; a refutation is a
      // hint and a timeout is nothing at all.
      return toolResultFrom(
        session,
        checked.outcome === "proved",
        `${prior}${gid} ${said(checked.outcome)}, ${budget}${detail}`,
        checked,
      );
    },
  });
}
