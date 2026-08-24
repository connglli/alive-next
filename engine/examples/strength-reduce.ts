// The smallest run there is: one check, and the root is discharged.
//
// The parameter is `noundef` here, expressing that the function input is
// defined (some scenarios like `freeze` deliberately leave it unconstrained to
// demonstrate poison-blocking). That is a fact about the pair rather than an
// out-of-band switch, so it lives in the IR, where a certificate can see it too.
import { expect, type Scenario } from "../core/scenario.ts";

export const strengthReduce: Scenario = {
  name: "strength-reduce",
  about: "one check discharges the root",

  src: `define i32 @f(i32 noundef %x) {
entry:
  %d = mul i32 %x, 2
  ret i32 %d
}
`,

  tgt: `define i32 @f(i32 noundef %x) {
entry:
  %d = shl i32 %x, 1
  ret i32 %d
}
`,

  async prove(session) {
    const checked = await session.check("g1");
    expect("check g1", checked.outcome === "proved", checked);
  },
};
