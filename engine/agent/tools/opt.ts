// tx_opt: one structural optimizer pass on the open transaction's scratch.
//
// The optimizers are LLVM's own machinery, so a simplification is the same
// algebra alive2 reasons about, but it is still a proposal: the commit that
// follows certifies it like any other rewrite.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Session } from "../../core/session.ts";
import type { EditResult } from "../../core/state/transactions.ts";
import { formatProgram, toolResult } from "./format.ts";

export function createOptTool(session: Session) {
  return defineTool({
    name: "tx_opt",
    label: "Optimize",
    description:
      "Apply one structural optimizer pass to the open transaction's program. simplify folds one instruction; instcombine combines instructions across the function. Answers with the body as it now stands, or, when the pass is refused, with the body it was refused on.",
    parameters: Type.Object({
      what: Type.Union([Type.Literal("simplify"), Type.Literal("instcombine")], {
        description: "Fold one instruction, or combine instructions across the function.",
      }),
      v: Type.Optional(
        Type.String({
          description: "The instruction for simplify, as %3, %x, or #7. Omit it for instcombine.",
        }),
      ),
      max_iterations: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Maximum InstCombine iterations; defaults to LLVM's default of 1.",
        }),
      ),
    }),
    execute: async (_id, params) => {
      let edited: EditResult;
      if (params.what === "instcombine") {
        edited = await session.opt({
          what: params.what,
          max_iterations: params.max_iterations,
        });
      } else {
        if (params.v === undefined) {
          return toolResult(false, "refused, bad_request: simplify needs 'v'", {
            kind: "refused",
            code: "bad_request",
            message: "simplify needs 'v'",
          });
        }
        edited = await session.opt({ what: params.what, v: params.v });
      }
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
