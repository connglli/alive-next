// check: ask alive2 whether a goal's claim holds as it stands.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

export function createCheckTool(session: Session) {
  return defineTool({
    name: "check",
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
      // Proved is the only outcome that advanced the run; a refutation is a
      // hint and a timeout is nothing at all.
      return toolResultFrom(
        session,
        checked.outcome === "proved",
        `${gid} ${checked.outcome}${detail}`,
        checked,
      );
    },
  });
}
