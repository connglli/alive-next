// tree_strengthen: give a cut's interface the facts its callee is missing.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Attrs, PredicateAssertion } from "../../core/drivers/llops.ts";
import type { Session } from "../../core/session.ts";
import type { StrengthenContract } from "../../core/state/strengthen.ts";
import { toolResultFrom } from "./format.ts";

export function createStrengthenTool(session: Session) {
  return defineTool({
    name: "tree_strengthen",
    label: "Strengthen",
    description:
      "Strengthen the interface of a function cut at a split boundary. Supports parameter attributes (param_attrs), function-level attributes (fn_attrs), and relational preconditions (predicates). Preconditions are certified at the caller before being assumed on the callee, and function attributes are certified on the callee before being assumed on the caller.",
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
          Type.Object({
            op: Type.String({
              description: "Relational predicate operator (eq, ne, slt, ugt, ...)",
            }),
            lhs: Type.Any({ description: 'Operand, e.g. {"arg": 0}' }),
            rhs: Type.Any({ description: 'Operand, e.g. {"arg": 1} or {"const": 0}' }),
          }),
          {
            description: "Relational comparison preconditions conjoined at the cut boundary.",
          },
        ),
      ),
    }),
    execute: async (_id, { gid, param_attrs, fn_attrs, predicates }) => {
      const contract: StrengthenContract = {
        ...(param_attrs ? { param_attrs: param_attrs as Record<number, Attrs> } : {}),
        ...(fn_attrs ? { fn_attrs } : {}),
        ...(predicates ? { predicates: predicates as PredicateAssertion[] } : {}),
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
        return toolResultFrom(
          session,
          false,
          `refused in the ${stronger.phase} phase: ${stronger.reason}${said}`,
          stronger,
        );
      }
      const proved = stronger.checks.filter((check) => check.outcome === "correct").length;
      return toolResultFrom(
        session,
        true,
        `strengthened contract on ${gid}, ${proved} of ${stronger.checks.length} checks came back correct`,
        stronger,
      );
    },
  });
}
