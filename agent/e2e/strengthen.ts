// A cut that loses a fact, and the strengthening that puts it back.
//
// The tgt narrows the multiply to i16, which is only sound because the mask
// before it leaves the value below 256. Cut between the two and the callee no
// longer knows that: on its own it is false, and alive2 says so with a
// counterexample above 65535. Strengthening states the range as an assume
// where the mask still proves it, and then attributes it to the parameter, at
// which point both halves hold.
//
// A fact is about a value being defined as much as about its range. An
// attribute a caller has to honour is violated by a poison or undef argument
// as surely as by an out of range one, and the assume that proves it says so:
// its condition is poison exactly when the value is, and an assume on a poison
// condition is UB the program did not have, so alive2 refuses the step. Here
// the parameter is `noundef` and the mask cannot make poison, so both facts
// hold; a parameter that could be poison would have to be frozen first, which
// is what LLVM does when it needs the same guarantee.
//
// So the two facts travel together in one call. The range is what the callee
// needs, and being defined is what the callee needs before any question about
// it can be answered at all.
import { expect, type Scenario } from "./scenario.ts";

export const strengthen: Scenario = {
  name: "strengthen",
  about: "a cut the callee cannot survive without a fact from its caller",

  src: `define i32 @f(i32 noundef %n) {
entry:
  %m = and i32 %n, 255
  %s = mul i32 %m, 2
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 noundef %n) {
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

    const stronger = await session.strengthen("g1", 0, {
      noundef: true,
      range: { min: 0, max: 256 },
    });
    expect("state the facts on the parameter", stronger.kind === "strengthened", stronger);
  },
};
