// report_cex: offer a whole program input as a counterexample.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { HarnessArg } from "../../core/drivers/llops.ts";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";

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
    name: "report_cex",
    label: "Report counterexample",
    description:
      "Offer one whole program input, an argument per parameter of the pair the run was asked about. Both programs are run on it under llubi, and a divergence seen there refutes the root and ends the run. A refutation from alive2 is not one of these: it speaks about whatever pair it was given, and may be about a state no input reaches.",
    parameters: Type.Object({
      input: Type.Array(Argument, {
        description: "One argument per parameter, in order.",
      }),
    }),
    execute: async (_id, { input }) => {
      const reported = await session.reportCex(input as HarnessArg[]);
      if (reported.kind === "refused") {
        return toolResultFrom(session, false, `not a counterexample: ${reported.reason}`, reported);
      }
      return toolResultFrom(session, true, `refuted: ${reported.divergence}`, reported);
    },
  });
}
