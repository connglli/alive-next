// tree_strengthen: give a cut's interface the facts its callee is missing.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import type { Facts } from "../../core/state/strengthen.ts";
import { toolResultFrom } from "./format.ts";

export function createStrengthenTool(session: Session) {
  return defineTool({
    name: "tree_strengthen",
    label: "Strengthen",
    description:
      "Put facts on the parameters of the function a cut made. Each is first proved where the evidence is, as an assume before the call in the outer src that alive2 has to certify, and only then attributed to the parameter. Give the whole interface at once: the cost is the same for one parameter or for all of them. A fact that does not hold is refused, and a value that can be undef or poison fails, which is what noundef is for.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal that was cut, not one of its children." }),
      facts: Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown()), {
        description:
          'By parameter position, as {"0": {"noundef": true}, "1": {"range": {"min": 0, "max": 256}}}.',
      }),
    }),
    execute: async (_id, { gid, facts }) => {
      const stronger = await session.strengthen(gid, facts as Facts);
      if (stronger.kind === "refused") {
        const said = stronger.check?.detail ? `\n${stronger.check.detail}` : "";
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
        `stated on ${Object.keys(facts).join(", ")}, ${proved} of ${stronger.checks.length} checks came back correct`,
        stronger,
      );
    },
  });
}
