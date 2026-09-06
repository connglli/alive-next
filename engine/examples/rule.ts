// Rewriting the src with a pre-proved rule, which is the shape of every proof
// that needs no solver for its step: the rewriter's proofs certify the move,
// and the check that follows it sees two identical programs and discharges the
// goal, so the script never asks whether it is done.
import { expect, type Scenario } from "../core/scenario.ts";

export const rule: Scenario = {
  name: "rule",
  about: "one verified-rewriter step, discharged by the check that follows it",

  src: `define i32 @f(i32 noundef %x, i32 noundef %y) {
entry:
  %a = mul i32 %x, 2
  %b = add i32 %a, %y
  ret i32 %b
}
`,

  tgt: `define i32 @f(i32 noundef %x, i32 noundef %y) {
entry:
  %a = shl i32 %x, 1
  %b = add i32 %a, %y
  ret i32 %b
}
`,

  async prove(session) {
    const rewritten = await session.rewrite("g1", "src", ["muli-pow2-to-shl"]);
    expect(
      "rewrite the multiply with a pre-proved rule",
      rewritten.kind === "certified",
      rewritten,
    );
  },
};
