// A loop refuted within its unroll factor.
//
// Both sides accumulate a sum the loop carries, and the target returns the
// value of one iteration too late. alive-tv answers a loop only for the
// iterations it unrolls, and a divergence within them refutes the root's
// original pair, which ends the run.
import { expect, type Scenario } from "../core/scenario.ts";

export const unroll: Scenario = {
  name: "unroll",
  about: "a loop refuted within its unroll factor",
  verdict: "counterexample",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %loop
loop:
  %i = phi i32 [0, %entry], [%i.next, %loop]
  %acc = phi i32 [0, %entry], [%acc.next, %loop]
  %i.next = add i32 %i, 1
  %acc.next = add i32 %acc, %i
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit
exit:
  ret i32 %acc
}
`,

  tgt: `define i32 @f(i32 noundef %n) {
entry:
  br label %loop
loop:
  %i = phi i32 [0, %entry], [%i.next, %loop]
  %acc = phi i32 [0, %entry], [%acc.next, %loop]
  %i.next = add i32 %i, 1
  %acc.next = add i32 %acc, %i
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit
exit:
  ret i32 %acc.next
}
`,

  async prove(session) {
    // For n = 2 the src returns the accumulated 0 and the tgt the 1 it added
    // after, which alive2 sees when it unrolls the loop twice.
    const checked = await session.check("g1", undefined, 2);
    expect("unrolled twice, the two part company", checked.outcome === "refuted", checked);
  },
};
