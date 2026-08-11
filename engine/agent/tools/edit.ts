// tx_edit: one rewrite of the open transaction's scratch program.
//
// The eleven operations are one tool taking an `op` rather than eleven tools,
// because the choice between them is a smaller decision than the choice
// between editing and cutting, and llops validates the arguments either way.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { EditOp } from "../../core/drivers/llops.ts";
import type { Session } from "../../core/session.ts";
import { formatProgram, toolResult } from "./format.ts";

const Ref = Type.String({
  description: "A value as the program prints it, %3 or %x, or #7 for the instruction at index 7.",
});
const Where = Type.Union([Type.Literal("before"), Type.Literal("after")]);
const Insts = Type.Array(Type.String(), {
  description: "Instruction text, as it would be written in the body.",
});

export const Op = Type.Union(
  [
    Type.Object({ op: Type.Literal("swap"), a: Ref, b: Ref }),
    Type.Object({ op: Type.Literal("move"), v: Ref, where: Where, w: Ref }),
    Type.Object({ op: Type.Literal("substitute"), a: Ref, b: Ref }),
    Type.Object({ op: Type.Literal("replace"), v: Ref, insts: Insts }),
    Type.Object({ op: Type.Literal("insert"), where: Where, w: Ref, insts: Insts }),
    Type.Object({ op: Type.Literal("erase"), v: Ref, cascade: Type.Optional(Type.Boolean()) }),
    Type.Object({ op: Type.Literal("commute"), v: Ref }),
    Type.Object({
      op: Type.Literal("retype"),
      v: Ref,
      ty: Type.String(),
      ext: Type.Optional(Type.Union([Type.Literal("zext"), Type.Literal("sext")])),
    }),
    Type.Object({ op: Type.Literal("dedup"), a: Ref, b: Ref }),
    Type.Object({ op: Type.Literal("set_body"), body: Type.String() }),
    Type.Object({
      op: Type.Literal("attrs"),
      fn: Type.String(),
      param: Type.Integer(),
      attrs: Type.Record(Type.String(), Type.Unknown()),
    }),
  ],
  // Every branch is an object, but a union alone says so only branch by
  // branch, and a provider that validates a tool's schema reads the top level:
  // a bare `anyOf` there is refused before the run has said anything. Saying
  // it once here keeps the eleven operations described one at a time.
  { type: "object" },
);

export type OpParams = Static<typeof Op>;

export function createEditTool(session: Session) {
  return defineTool({
    name: "tx_edit",
    label: "Edit",
    description:
      "Rewrite the open transaction's program. Answers with the body as it now stands, or, when the operation is refused, with the body it was refused on. Value references move as a body is edited, so address the body you were last answered with.",
    parameters: Op,
    execute: async (_id, params) => {
      const edited = await session.edit(params as EditOp);
      if (edited.kind === "refused") {
        return toolResult(
          false,
          formatProgram(`refused, ${edited.code}: ${edited.message}`, edited.text),
          edited,
        );
      }
      return toolResult(true, formatProgram(`applied, ${edited.ops} so far`, edited.text), {
        kind: edited.kind,
        ops: edited.ops,
      });
    },
  });
}
