// tree_case: prove a goal by cases on its inputs.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import type { CaseOn } from "../../core/state/trajectory.ts";
import { toolResultFrom } from "./format.ts";
import { ComparisonShape } from "./strengthen.ts";

export function createCaseTool(session: Session) {
  return defineTool({
    name: "tree_case",
    label: "Case",
    description:
      'Split a goal into two cases of its inputs, holds and fails, which together cover every input, so proving both proves the goal. When on is {"defined": "!N"}, case holds makes parameter N noundef on both sides, and case fails puts poison in its place. When on is a comparison of two parameters, or of a parameter and an integer, such as {"op": "ult", "lhs": "!0", "rhs": 3}, case holds assumes it at the start of both programs, and case fails assumes the opposite comparison. A comparison needs each parameter it names to be noundef in the src. Where one is not, first split on whether that parameter is poison. Within a case, a branch on the comparison the case assumes always goes the same way. So goal_check proves a case whose two sides differ only in such branches, as they do in a loop unswitched on a parameter.',
    parameters: Type.Object({
      gid: Type.String(),
      on: Type.Union([
        Type.Object({
          defined: Type.String({ description: "A parameter, named !0, !1, ... by its index." }),
        }),
        ComparisonShape,
      ]),
    }),
    execute: async (_id, { gid, on }) => {
      const cut = await session.case(gid, on as CaseOn);
      if (cut.kind !== "cased") {
        return toolResultFrom(session, false, `refused: ${cut.message}`, cut);
      }
      const { holds, fails } = cut.children;
      return toolResultFrom(
        session,
        true,
        `${gid} is cut by cases: holds ${holds}, fails ${fails}`,
        cut,
      );
    },
  });
}
