// tx_commit: certify the open transaction as one step.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import type { Fallback } from "../../core/state/steps.ts";
import { nameFor, toolResultFrom } from "./format.ts";

export function createCommitTool(session: Session) {
  return defineTool({
    name: "tx_commit",
    label: "Commit",
    description:
      "Validate the open transaction with alive2, in the direction the side implies, and advance the head if it holds. On refusal the head does not move and the scratch stays open, so edit it further or discard it with tx_abort. A counterexample comes back as a hint. The goal's new pair is then eagerly checked once on a small budget, so a step that finishes a chain discharges the goal here.",
    parameters: Type.Object({
      window: Type.Optional(
        Type.Object({
          from: Type.String({ description: "Reference to the start instruction of the window." }),
          to: Type.String({ description: "Reference to the end instruction of the window." }),
        }),
      ),
      preconditions: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description:
            "Preconditions on live-in values of the window (e.g. { '%v1': { 'noundef': true } }).",
        }),
      ),
    }),
    execute: async (_id, args) => {
      const step = await session.commit(args, /*imm_abort=*/ false);
      if (step.kind === "refused") {
        // The budget is part of the refusal: a timeout says how much was
        // spent failing, and a refusal that spent nothing says that instead.
        const budgetMs = step.check.invocation.timeoutMs;
        const budget = budgetMs > 0 ? ` on a ${budgetMs}ms budget` : "";
        const fallback = fallbackSummary(step.fallback);
        return toolResultFrom(
          session,
          false,
          `refused${budget}: ${step.check.detail || step.check.outcome}${fallback}; transaction remains open`,
          step,
        );
      }
      const fallback = fallbackSummary(step.fallback);
      let eager = "";
      if (step.eager) {
        const eagerOutcome =
          step.eager.outcome === "correct"
            ? "proved"
            : step.eager.outcome === "incorrect"
              ? "refuted"
              : "unknown";
        const eagerBudget = step.eager.invocation.timeoutMs;
        const eagerMs = step.eager.ms;
        const eagerDetail =
          step.eager.outcome === "incorrect" && step.eager.detail ? `\n${step.eager.detail}` : "";
        eager =
          eagerOutcome === "proved"
            ? `, the new pair is proved in ${eagerMs}ms (${eagerBudget}ms budget)`
            : `, the new pair is ${eagerOutcome} (${eagerMs}ms, ${eagerBudget}ms budget)${eagerDetail}`;
      }
      return toolResultFrom(
        session,
        true,
        `certified${fallback}, head is ${nameFor(session, step.hash)}${eager}`,
        step,
      );
    },
  });
}

function fallbackSummary(fallback?: Fallback): string {
  if (fallback?.reason === "window_unproved" && fallback.narrowed) {
    const narrowOutcome =
      fallback.narrowed.outcome === "incorrect" ? "refuted" : fallback.narrowed.outcome;
    return ` (whole-function fallback: window check was ${narrowOutcome} in ${fallback.narrowed.ms}ms)`;
  }
  if (fallback?.reason === "no_window") {
    return ` (whole-function fallback: no local window (edit covered the body))`;
  }
  return "";
}
