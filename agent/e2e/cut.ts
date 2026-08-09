// Cutting a goal in two and proving the halves.
//
// Nothing here needs the cut, since alive2 would take the pair whole. It is
// the mechanism on the smallest program that shows it: the prefix is shared,
// so the outer pair is two identical programs around the same call, and the
// difference is alone in the callee.
//
// Canonically `%0` is the parameter, `%1` the add and `%2` the multiply, which
// is where both sides are cut.
import { expect, type Scenario } from "./scenario.ts";

export const cut: Scenario = {
  name: "cut",
  about: "a split, and a check on each half",

  src: `define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %b = mul i32 %a, 8
  %c = sub i32 %b, %x
  ret i32 %c
}
`,

  tgt: `define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %b = shl i32 %a, 3
  %c = sub i32 %b, %x
  ret i32 %c
}
`,

  async prove(session) {
    // The suffix uses the add and the parameter, so both cross the cut.
    const split = await session.split("g1", "%2", "%2", { "%0": "%0", "%1": "%1" });
    expect("cut at the multiply", split.kind === "split", split);
    if (split.kind !== "split") return;

    const outer = await session.check(split.children.outer);
    expect(`check ${split.children.outer}`, outer.outcome === "proved", outer);
    const callee = await session.check(split.children.callee);
    expect(`check ${split.children.callee}`, callee.outcome === "proved", callee);
  },
};
