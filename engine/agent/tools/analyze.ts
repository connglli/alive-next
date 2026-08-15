// goal_analyze: what an LLVM analysis says about one side of a goal.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AnalyzeKind } from "../../core/drivers/llops.ts";
import type { Session } from "../../core/session.ts";
import { toolResult } from "./format.ts";

const KINDS: AnalyzeKind[] = ["knownbits", "ranges", "pointer", "defined"];

export function createAnalyzeTool(session: Session) {
  return defineTool({
    name: "goal_analyze",
    label: "Analyze",
    description:
      "Run an analysis over one side of a goal and report what it found about each value. The facts are proposals: one counts only once a certified step has put it in a program, which is what tree_strengthen does at a cut. Note: 'ranges' reports inclusive bounds; when converting to a tree_strengthen range attribute, remember range there is half-open [min, max) with exclusive max.",
    parameters: Type.Object({
      gid: Type.String(),
      side: Type.Union([Type.Literal("src"), Type.Literal("tgt")]),
      kind: Type.Union(KINDS.map((kind) => Type.Literal(kind))),
      point: Type.Optional(
        Type.String({ description: "Ask at this value rather than over the whole body." }),
      ),
    }),
    execute: async (_id, { gid, side, kind, point }) => {
      const found = await session.analyze(gid, side, kind, point);
      if (!found.ok) return toolResult(false, `${found.code}: ${found.message}`, found);
      const facts = found.facts.map((fact) => JSON.stringify(fact)).join("\n");
      return toolResult(true, facts || `nothing to say about ${gid} ${side}`, found);
    },
  });
}
