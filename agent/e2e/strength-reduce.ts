// The smallest run there is: one check, and the root is discharged.
import { expect, type Scenario } from "./scenario.ts";

export const strengthReduce: Scenario = {
  name: "strength-reduce",
  about: "one check discharges the root",

  src: `define i32 @f(i32 %x) {
entry:
  %d = mul i32 %x, 2
  ret i32 %d
}
`,

  tgt: `define i32 @f(i32 %x) {
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
