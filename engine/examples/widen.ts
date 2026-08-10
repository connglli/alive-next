// A load widened past the object it reads from.
//
// Reading one byte as a four byte load and masking off the rest is what a real
// widening does, and it is sound only where the object is known to hold four
// bytes. Nothing in this pair says it does, so on a one byte object the tgt
// reads out of bounds where the src is defined.
//
// The input here is memory: the parameter is a pointer, and the harness
// allocates the bytes behind it before the call and reads them back after, so
// what each side left in the caller's memory is compared like any other
// observation.
import { expect, type Scenario } from "../core/scenario.ts";

export const widen: Scenario = {
  name: "widen",
  about: "a target that reads past the object where the source does not",
  verdict: "counterexample",

  src: `define i32 @f(ptr noundef %p) {
entry:
  %a = load i8, ptr %p, align 1
  %z = zext i8 %a to i32
  ret i32 %z
}
`,

  tgt: `define i32 @f(ptr noundef %p) {
entry:
  %w = load i32, ptr %p, align 1
  %m = and i32 %w, 255
  ret i32 %m
}
`,

  async prove(session) {
    const checked = await session.check("g1");
    expect("the check refutes the pair", checked.outcome === "refuted", checked);

    // One byte behind the pointer, which is all the src ever reads.
    const reported = await session.reportCex([{ kind: "bytes", bytes: [7] }]);
    expect("the tgt reads what is not there", reported.kind === "refuted", reported);
  },
};
