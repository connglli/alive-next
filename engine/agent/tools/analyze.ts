// goal_analyze: what an LLVM analysis says about one side of a goal.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AnalyzeKind, Fact, Scev } from "../../core/drivers/llops.ts";
import type { Session } from "../../core/session.ts";
import { formatSection, toolResult } from "./format.ts";

const KINDS: AnalyzeKind[] = ["knownbits", "ranges", "pointer", "defined", "scev"];

export function createAnalyzeTool(session: Session) {
  return defineTool({
    name: "goal_analyze",
    label: "Analyze",
    description:
      "Run an analysis over one side of a goal and report what it found about each value. The facts are proposals: one counts only once a certified step has put it in a program, which is what tree_strengthen does at a cut. 'ranges' reports bounds that include both ends, while a range in tree_strengthen includes min but not max.",
    parameters: Type.Object({
      gid: Type.String(),
      side: Type.Union([Type.Literal("src"), Type.Literal("tgt")]),
      kind: Type.Union(KINDS.map((kind) => Type.Literal(kind))),
      point: Type.Optional(
        Type.String({
          description:
            "Ask just before this instruction rather than at the end of the body; a body of several blocks needs one.",
        }),
      ),
    }),
    execute: async (_id, { gid, side, kind, point }) => {
      const found = await session.analyze(gid, side, kind, point);
      if (!found.ok) return toolResult(false, `refused: ${found.message}`, found);
      // The no-undef model rules undef out, so a value is noundef exactly when
      // it is not poison, and not_undef and not_poison say no more than that.
      const shown = ({ not_undef, not_poison, scev, ...fact }: Fact) => ({
        ...fact,
        ...(not_poison === undefined ? {} : { noundef: not_poison }),
        ...(scev ? { scev: printScev(scev) } : {}),
      });
      const facts = found.facts.map((fact) => JSON.stringify(shown(fact))).join("\n");
      return toolResult(
        true,
        facts ? formatSection("Facts", facts) : `nothing to say about ${gid} ${side}`,
        found,
      );
    },
  });
}

/** An expression as ScalarEvolution prints it, such as `{%0,+,-1}<nsw><%bb1>`. */
function printScev(node: Scev): string {
  const ops = (node.operands ?? []).map(printScev);
  const flags = (node.flags ?? []).map((flag) => `<${flag}>`).join("");
  switch (node.op) {
    case "const":
    case "value":
      return node.value ?? "";
    case "vscale":
      return "vscale";
    case "addrec":
      return `{${ops.join(",+,")}}${flags}<${node.loop}>`;
    case "add":
      return `(${ops.join(" + ")})${flags}`;
    case "mul":
      return `(${ops.join(" * ")})${flags}`;
    case "udiv":
      return `(${ops.join(" /u ")})`;
    case "trunc":
    case "zext":
    case "sext":
    case "ptrtoint":
      return `(${node.op} ${node.operands?.[0]?.type} ${ops[0]} to ${node.type})`;
    default:
      return `(${ops.join(` ${node.op} `)})`;
  }
}
