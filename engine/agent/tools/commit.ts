// tx_commit: certify the open transaction as one step.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import type { Fallback } from "../../core/state/steps.ts";
import { formatEager, formatMoved, outcomeWord, toolResultFrom } from "./format.ts";

export function createCommitTool(session: Session) {
  return defineTool({
    name: "tx_commit",
    label: "Commit",
    description:
      "Check the open transaction as one step with alive2, in the direction tx_begin stated. If the step holds, the side becomes the edited program. alive2 first checks only the instructions the edits changed, or the window you give, and then the whole function if needed. If the commit is refused, the side does not change and the transaction stays open, so you can edit further or discard it with tx_abort. A counterexample is only a hint. After a step, the goal's new pair is checked once on a small budget, so the last step of a proof proves the goal here.",
    parameters: Type.Object({
      window: Type.Optional(
        Type.Object(
          {
            from: Type.String({
              description:
                "The window's first instruction, as %N or #N in the program the transaction started from.",
            }),
            to: Type.String({
              description: "The window's last instruction, as %N or #N in the same program.",
            }),
          },
          {
            description:
              "A window you choose, in the program the transaction started from: a run of instructions in one block that includes every changed instruction and may include unchanged ones. The matching window in the edited program is found for you, even if the edits renamed values.",
          },
        ),
      ),
      preconditions: Type.Optional(
        Type.Record(Type.String(), Type.Any(), {
          description:
            "Preconditions on values the window uses, named as in the program the transaction started from, for example { '%v1': { 'noundef': true } }.",
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
        `certified${asked(step.fallback)}, ${formatMoved(session, step.effects)}${eager}`,
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
