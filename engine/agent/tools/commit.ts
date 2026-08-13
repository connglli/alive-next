// tx_commit: certify the open transaction as one step.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { nameFor, toolResultFrom } from "./format.ts";

export function createCommitTool(session: Session) {
  return defineTool({
    name: "tx_commit",
    label: "Commit",
    description:
      "Validate the whole of the open transaction with alive2, in the direction the side implies, and advance the head if it holds. On refusal the head does not move and the counterexample comes back as a hint. The goal's new pair is then checked once on a small budget, so a step that finishes a chain discharges the goal here.",
    parameters: Type.Object({}),
    execute: async () => {
      const step = await session.commit();
      if (step.kind === "refused") {
        // The budget is part of the refusal: a timeout says how much was
        // spent failing, and a refusal that spent nothing says that instead.
        const budgetMs = step.check.invocation.timeoutMs;
        const budget = budgetMs > 0 ? ` on a ${budgetMs}ms budget` : "";
        return toolResultFrom(
          session,
          false,
          `refused${budget}: ${step.check.detail || step.check.outcome}`,
          step,
        );
      }
      const eager = step.eager ? `, the pair is ${step.eager.outcome}` : "";
      return toolResultFrom(
        session,
        true,
        `certified, head is ${nameFor(session, step.hash)}${eager}`,
        step,
      );
    },
  });
}
