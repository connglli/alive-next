// Rewriting the src until it is the tgt, which is the shape of every proof
// that is not a single check: the step is certified, and the check that
// follows it sees two identical programs and discharges the goal, so the
// script never asks whether it is done.
//
// The store holds canonical text, so values are named by slot: `%0` and `%1`
// are the parameters and `%2` is the multiply.
import { expect, type Scenario } from "./scenario.ts";

export const rewrite: Scenario = {
  name: "rewrite",
  about: "one certified step, discharged by the check that follows it",

  src: `define i32 @f(i32 noundef %x, i32 noundef %y) {
entry:
  %a = mul i32 %x, 4
  %b = add i32 %a, %y
  ret i32 %b
}
`,

  tgt: `define i32 @f(i32 noundef %x, i32 noundef %y) {
entry:
  %a = shl i32 %x, 2
  %b = add i32 %a, %y
  ret i32 %b
}
`,

  async prove(session) {
    await session.begin("g1", "src");
    const edited = await session.edit({ op: "replace", v: "%2", insts: ["%sh = shl i32 %0, 2"] });
    expect("replace the multiply", edited.kind === "applied", edited);
    const step = await session.commit();
    expect("commit the rewrite", step.kind === "certified", step);
  },
};
