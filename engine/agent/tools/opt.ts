// tx_opt: one structural optimizer pass on the open transaction's scratch.
//
// The optimizers are LLVM's own machinery, so a simplification is the same
// algebra alive2 reasons about, but it is still a proposal: the commit that
// follows certifies it like any other rewrite.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import { formatProgram, toolResult } from "./format.ts";

export function createOptTool(session: Session) {
  return defineTool({
    name: "tx_opt",
    label: "Optimize",
    description:
      "Apply one structural optimizer pass to the open transaction's program. simplify folds one instruction with LLVM's own simplifier and erases it, or leaves the program unchanged when there is nothing to fold. Answers with the body as it now stands, or, when the pass is refused, with the body it was refused on.",
    parameters: Type.Object({
      what: Type.Literal("simplify", {
        description: "Fold one instruction with LLVM's own simplifier.",
      }),
      v: Type.String({
        description:
          "A value as the program prints it, %3 or %x, or #7 for the instruction at index 7.",
      }),
    }),
    execute: async (_id, params) => {
      const edited = await session.opt({ what: params.what, v: params.v });
      if (edited.kind === "refused") {
        return toolResult(
          false,
          formatProgram(`refused, ${edited.code}: ${edited.message}`, edited.text),
          edited,
        );
      }
      if (edited.kind === "unchanged") {
        return toolResult(true, formatProgram(`unchanged, nothing to fold`, edited.text), edited);
      }
      return toolResult(true, formatProgram(`applied, ${edited.ops} so far`, edited.text), {
        kind: edited.kind,
        ops: edited.ops,
      });
    },
  });
}
