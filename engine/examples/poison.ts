// A flag the source does not justify, and the input that shows it.
//
// Adding `nsw` to a wrapping add is the unsound direction of the edit the
// reassociation example makes: dropping a flag weakens what a program claims,
// while adding one makes it poisonous where it used to have a value. Nothing
// here says the addition cannot overflow, so at the largest positive integer
// the src wraps and the tgt is poison.
//
// The harness stores what the entry returned so that it can be observed, and
// storing poison is UB, so a tgt that returns poison stops there rather than
// producing a value. That is what tells this apart from a tgt with UB of its
// own, which the load widening example shows.
import { expect, type Scenario } from "../core/scenario.ts";

export const poison: Scenario = {
  name: "poison",
  about: "a target that returns poison where the source returns a value",
  verdict: "counterexample",

  src: `define i32 @f(i32 noundef %x) {
entry:
  %s = add i32 %x, 1
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 noundef %x) {
entry:
  %s = add nsw i32 %x, 1
  ret i32 %s
}
`,

  async prove(session) {
    const checked = await session.check("g1");
    expect("the check refutes the pair", checked.outcome === "refuted", checked);

    // The only input the addition overflows on, so the only one that shows it.
    const reported = await session.reportCex([{ kind: "int", value: "2147483647" }]);
    expect("the tgt is poison at the largest integer", reported.kind === "refuted", reported);
  },
};
