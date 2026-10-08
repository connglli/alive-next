// tree_strengthen_preview: which facts tree_strengthen would prove, proving none.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Attrs, Predicate } from "../../core/drivers/llops.ts";
import type { Session } from "../../core/session.ts";
import { toolResultFrom } from "./format.ts";
import { ParamAttrs, Predicates } from "./strengthen.ts";

export function createStrengthenPreviewTool(session: Session) {
  return defineTool({
    name: "tree_strengthen_preview",
    label: "Strengthen Preview",
    description:
      "Preview tree_strengthen without changing the goal tree: answers which of the given parameter attributes and preconditions would prove, each asked alone.",
    parameters: Type.Object({
      gid: Type.String({ description: "The goal that was cut, not one of its children." }),
      param_attrs: ParamAttrs,
      predicates: Predicates,
    }),
    execute: async (_id, { gid, param_attrs, predicates }) => {
      const preview = await session.strengthenPreview(gid, {
        ...(param_attrs ? { param_attrs: param_attrs as Record<number, Attrs> } : {}),
        ...(predicates ? { predicates: predicates as Predicate[] } : {}),
      });
      if (preview.kind === "refused") {
        return toolResultFrom(session, false, `refused: ${preview.reason}`, preview);
      }
      const { holds } = preview;
      const found =
        Object.keys(holds.param_attrs ?? {}).length + (holds.predicates ?? []).length > 0
          ? `these hold, as tree_strengthen takes them: ${JSON.stringify(holds)}`
          : "none holds";
      return toolResultFrom(session, true, `of the facts given for ${gid}, ${found}`, preview);
    },
  });
}
