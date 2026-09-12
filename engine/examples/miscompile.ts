// A translation that is wrong, and the input that proves it.
//
// Halving a signed integer is not a shift: `sdiv` rounds toward zero and
// `ashr` rounds down, so the two disagree on every negative odd value. The
// check refutes the pair, and the replay on the input below is what the
// certificate carries.
//
// The script first checks the pair, then offers a concrete input. The
// framework runs both programs on it under llubi and compares the results.
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
    // A check of the pair the run was asked about refutes the run, and no
    // input has been replayed yet.
    const checked = await session.check("g1");
    expect("the check refutes the pair", checked.outcome === "refuted", checked);

    // Rounding parts company below zero, so the smallest witness is an odd
    // negative: the src gives -1 and the tgt gives -2.
    const reported = await session.reportCex([{ kind: "int", value: "-3" }]);
    expect("the two programs diverge on -3", reported.kind === "refuted", reported);
  },
};
