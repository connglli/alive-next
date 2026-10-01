// tx_commit: certify the open transaction as one step.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import type { Fallback } from "../../core/state/steps.ts";
import { formatEager, nameFor, outcomeWord, toolResultFrom } from "./format.ts";

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
              "Optional explicit window in the PRE-EDIT (before/head) program: instructions of one block that cover every edit, unchanged ones allowed. Its post-edit counterpart is derived, whatever the edits named.",
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
        const said = `the step is ${outcomeWord(step.check.outcome)}${budget}${asked(step.fallback)}`;
        const detail = step.check.detail ? `\n${step.check.detail}` : "";
        return toolResultFrom(
          session,
          false,
          `refused: ${said}; transaction remains open${detail}`,
          step,
        );
      }
      const eager = formatEager(step.eager);
      return toolResultFrom(
        session,
        true,
        `certified${asked(step.fallback)}, head is ${nameFor(session, step.hash)}${eager}`,
        step,
      );
    },
  });
}

/** How the step was asked, when not as the window its edits touched. */
function asked(fallback?: Fallback): string {
  if (fallback?.reason === "preconditions_refused") {
    return ` without its preconditions, since ${fallback.conditioning}`;
  }
  if (fallback?.reason === "window_unproved" && fallback.narrowed) {
    const { outcome, ms, invocation } = fallback.narrowed;
    const budget = invocation.timeoutMs > 0 ? ` on a ${invocation.timeoutMs}ms budget` : "";
    const { before, after } = fallback.window ?? {};
    const bounds =
      before && after
        ? ` ${before.from}..${before.to} (${after.from}..${after.to} after the edit)`
        : "";
    const pre =
      fallback.preconditions && Object.keys(fallback.preconditions).length > 0
        ? ` with preconditions (${factsOf(fallback.preconditions)})`
        : "";
    const without = fallback.conditioning
      ? `, without its preconditions since ${fallback.conditioning}`
      : "";
    return `, asked of the whole function after its window${bounds}${pre} was ${outcomeWord(outcome)} in ${ms}ms${budget}${without}`;
  }
  if (fallback?.reason === "no_window") {
    const since = fallback.narrowing ? ` since ${fallback.narrowing}` : "";
    return `, asked of the whole function with no window${since}`;
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
