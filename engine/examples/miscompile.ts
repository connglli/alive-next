// A translation that is wrong, and the input that proves it.
//
// Halving a signed integer is not a shift: `sdiv` rounds toward zero and
// `ashr` rounds down, so the two disagree on every negative odd value. This is
// the classic form of a real miscompilation, and the run ends the way one
// should: not with what alive2 said, but with a whole-program input on which
// the two programs do visibly different things.
//
// The check is what a search does first, and it comes back refuted with a
// counterexample of alive2's own. That is a hint and nothing more, so the
// script does what an agent would do with a hint: it offers a concrete input,
// and the framework runs both programs on it under llubi. The divergence it
// sees for itself is what refutes the root.
import { expect, type Scenario } from "../core/scenario.ts";

export const miscompile: Scenario = {
  name: "miscompile",
  about: "a refutation certified by running both programs",
  verdict: "counterexample",

  src: `define i32 @f(i32 noundef %x) {
entry:
  %h = sdiv i32 %x, 2
  ret i32 %h
}
`,

  tgt: `define i32 @f(i32 noundef %x) {
entry:
  %h = ashr i32 %x, 1
  ret i32 %h
}
`,

  async prove(session) {
    // A refutation leaves the goal open, because a local counterexample is a
    // hint about the pair and not yet a fact about the translation.
    const checked = await session.check("g1");
    expect("the check refutes the pair", checked.outcome === "refuted", checked);

    // Rounding parts company below zero, so the smallest witness is an odd
    // negative: the src gives -1 and the tgt gives -2.
    const reported = await session.reportCex([{ kind: "int", value: "-3" }]);
    expect("the two programs diverge on -3", reported.kind === "refuted", reported);
  },
};
