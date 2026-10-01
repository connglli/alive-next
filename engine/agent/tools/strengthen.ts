// tree_strengthen: give a cut's interface the facts its callee is missing.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Attrs, Predicate } from "../../core/drivers/llops.ts";
import type { Session } from "../../core/session.ts";
import type { StrengthenContract } from "../../core/state/strengthen.ts";
import { toolResultFrom } from "./format.ts";

export function createStrengthenTool(session: Session) {
  return defineTool({
    name: "tree_strengthen",
    label: "Strengthen",
    description:
      "Add facts to the interface of the function a goal was cut into. Parameter attributes (param_attrs) and preconditions (predicates) are first proved where the outer program calls the function, and for a loop also where one iteration calls the hypothesis; only then may the callee assume them. Function attributes (fn_attrs) are first proved on the callee; only then may the outer program assume them.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal that was cut, not one of its children." }),
      param_attrs: Type.Optional(
        Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()), {
          description:
            'Parameter attributes by parameter index (0, 1, ...), e.g. {"0": {"noundef": true}, "1": {"range": {"min": 0, "max": 256}}}.',
        }),
      ),
      fn_attrs: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            'Function-level semantic attributes, e.g. {"memory": "none", "nounwind": true, "willreturn": true}.',
        }),
      ),
      predicates: Type.Optional(
        Type.Array(
          Type.Union([
            Type.Object({
              op: Type.String(),
              lhs: Type.Union([Type.String(), Type.Number()]),
              rhs: Type.Union([Type.String(), Type.Number()]),
            }),
            Type.Object({ insts: Type.Array(Type.String()) }),
          ]),
          {
            description:
              'Preconditions over the callee\'s arguments, named !0, !1, ... by parameter index, as in param_attrs. Each is a comparison, e.g. {"op": "ule", "lhs": "!1", "rhs": "!0"}, or lines of IR whose last line defines an i1, e.g. {"insts": ["%rest = sub i32 !3, !0", "%ok = icmp eq i32 !2, %rest"]}.',
          },
        ),
      ),
    }),
    execute: async (_id, { gid, param_attrs, fn_attrs, predicates }) => {
      const contract: StrengthenContract = {
        ...(param_attrs ? { param_attrs: param_attrs as Record<number, Attrs> } : {}),
        ...(fn_attrs ? { fn_attrs } : {}),
        ...(predicates ? { predicates: predicates as Predicate[] } : {}),
      };
      const stronger = await session.strengthen(gid, contract);
      if (stronger.kind === "editing") {
        return toolResultFrom(session, false, `refused: ${stronger.message}`, stronger);
      }
      if (stronger.kind === "refused") {
        const said = stronger.explanation
          ? `\n\n${stronger.explanation}`
          : stronger.check?.detail
            ? `\n\n${stronger.check.detail}`
            : "";
        return toolResultFrom(session, false, `refused: ${stronger.reason}${said}`, stronger);
      }
      return toolResultFrom(session, true, `strengthened the interface of ${gid}`, stronger);
    },
  });
}
