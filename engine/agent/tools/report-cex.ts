// run_report_cex: offer a whole program input as a counterexample.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InputArg } from "../../core/drivers/llops.ts";
import type { Session } from "../../core/session.ts";
import { formatDetail, toolResultFrom } from "./format.ts";

const Argument = Type.Union([
  Type.Object({
    kind: Type.Literal("int"),
    value: Type.String({ description: "The value as text, signed decimal or 0x hex." }),
  }),
  Type.Object({
    kind: Type.Literal("bytes"),
    bytes: Type.Array(Type.Integer()),
    align: Type.Optional(Type.Integer()),
  }),
  Type.Object({ kind: Type.Literal("null") }),
]);

export function createReportCexTool(session: Session) {
  return defineTool({
    name: "run_report_cex",
    label: "Report counterexample",
    description:
      "Offer one whole program input, an argument per parameter of the pair the run was asked about. alive2 is asked about the pair at that input, or llubi runs both programs on it where alive2 does not decide, and a divergence refutes the root and ends the run. A refutation of any other pair does not count: it is about that pair, and may describe a state no input reaches.",
    parameters: Type.Object({
      input: Type.Array(Argument, {
        description: "One argument per parameter, in order.",
      }),
      unroll: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "For a pair that loops: how many iterations to search.",
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Integer({
          description: "How long the solver may run, in ms, up to the cap run_status shows.",
        }),
      ),
    }),
    execute: async (_id, { input, unroll, timeout_ms }) => {
      const reported = await session.reportCex(input as InputArg[], unroll, timeout_ms);
      const said = [formatDetail(reported.check)];
      if (reported.kind === "refused") {
        const refused = `not a counterexample: ${reported.reason}`;
        return toolResultFrom(session, false, refused, reported, said);
      }
      const refuted = `refuted by ${reported.checker}: ${reported.divergence}`;
      return toolResultFrom(session, true, refuted, reported, said);
    },
  });
}
