// A cut that loses a fact, and the strengthening that puts it back.
//
// The tgt narrows the multiply to i16, which is only sound because the mask
// before it leaves the value below 256. Cut between the two and the callee no
// longer knows that: on its own it is false, and alive2 says so with a
// counterexample above 65535. Strengthening puts the range on the callee's
// declaration in the outer, where the mask still proves it, and then on the
// callee's parameter, at which point both halves hold.
//
// The range holds although `%n` may be poison. A value a range rules out is
// poison, so the outer with the range refines the one without when every value
// it passes is in range or poison, which the mask makes so. The callee assumes
// no more than that: a poison parameter makes both of its sides poison. A fact
// that needs a defined value, such as `noundef` or a predicate, would not hold.
import { expect, type Scenario } from "../core/scenario.ts";

export const strengthen: Scenario = {
  name: "strengthen",
  about: "a cut the callee cannot survive without a fact from its caller",
  verdict: "verified",

  src: `define i32 @f(i32 %n) {
entry:
  %m = and i32 %n, 255
  %s = mul i32 %m, 2
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 %n) {
entry:
  %m = and i32 %n, 255
  %t = trunc i32 %m to i16
  %p = mul i16 %t, 2
  %s = zext i16 %p to i32
  ret i32 %s
}
`,

  async prove(session) {
    // `%2` is the multiply on both sides, and the masked value `%1` crosses.
    const split = await session.split("g1", "%2", "%2", { "%1": "%1" });
    expect("cut at the multiply", split.kind === "split", split);
    if (split.kind !== "split") return;

    // A local counterexample is a hint, so this leaves the goal open and the
    // script goes on to supply what the callee is missing.
    await session.check(split.children.callee);

    const stronger = await session.strengthen("g1", {
      param_attrs: { 0: { range: { min: 0, max: 256 } } },
    });
    expect("state the range on the parameter", stronger.kind === "strengthened", stronger);
  },
};
