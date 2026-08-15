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
      "Validate the open transaction with alive2, in the direction the side implies, and advance the head if it holds. Local step narrowing is attempted automatically over the changed instructions; an explicit window can optionally be given in the PRE-EDIT (before) program. On refusal the head does not move and the scratch stays open, so edit it further or discard it with tx_abort. A counterexample comes back as a hint. The goal's new pair is then eagerly checked once on a small budget, so a step that finishes a chain discharges the goal here.",
    parameters: Type.Object({
      window: Type.Optional(
        Type.Object(
          {
            from: Type.String({
              description:
                "Reference to start instruction of the window in the PRE-EDIT (before/head) program.",
            }),
            to: Type.String({
              description:
                "Reference to end instruction of the window in the PRE-EDIT (before/head) program.",
            }),
          },
          {
            description:
              "Optional explicit window in the PRE-EDIT (before/head) program. The corresponding window in the post-edit scratch is derived automatically.",
          },
        ),
      ),
      preconditions: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description:
            "Preconditions on live-in values of the window named in the PRE-EDIT (before/head) program (e.g. { '%v1': { 'noundef': true } }).",
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
  if (fallback?.reason === "preconditions_refused") {
    return ` (the preconditions were not used: ${fallback.conditioning})`;
  }
  if (fallback?.reason === "window_unproved" && fallback.narrowed) {
    const narrowOutcome =
      fallback.narrowed.outcome === "incorrect" ? "refuted" : fallback.narrowed.outcome;
    const ms = fallback.narrowed.ms;
    const budgetMs = fallback.narrowed.invocation.timeoutMs;
    const budget = budgetMs > 0 ? ` on a ${budgetMs}ms budget` : "";
    const bounds = fallback.window
      ? ` (before: ${fallback.window.before.from}..${fallback.window.before.to}, after: ${fallback.window.after.from}..${fallback.window.after.to})`
      : "";
    const pre =
      fallback.preconditions && Object.keys(fallback.preconditions).length > 0
        ? ` with preconditions (${factsOf(fallback.preconditions)})`
        : "";
    const conditioning = fallback.conditioning
      ? `; the preconditions were not used: ${fallback.conditioning}`
      : "";
    return ` (whole-function fallback: window check${bounds}${pre} was ${narrowOutcome} in ${ms}ms${budget}${conditioning})`;
  }
  if (fallback?.reason === "no_window") {
    return " (whole-function fallback: no local window found across edits)";
  }
  return "";
}

/** The facts of a conditioned window, as a reader can act on them. */
function factsOf(preconditions: Record<string, Record<string, unknown>>): string {
  return Object.entries(preconditions)
    .map(
      ([param, facts]) =>
        `parameter ${param}: ${Object.entries(facts)
          .map(([kind, spec]) => (spec === true ? kind : `${kind} ${JSON.stringify(spec)}`))
          .join(", ")}`,
    )
    .join("; ");
}
