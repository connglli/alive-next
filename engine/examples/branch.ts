// A branch that cannot be checked whole, detached at its join.
//
// One arm computes x + y - (x & y), which the tgt writes as x | y, and after
// the join both sides run the same chain of 64-bit divisions and products on
// the joined value. Asked as one pair, alive-tv has to carry the arm's bit
// identity through that chain, and gives no answer in a minute. Detached at
// the join, the outer only asks whether the two sides pass the same value,
// and the callee pair is the same text on both sides.
import { expect, type Scenario } from "../core/scenario.ts";

export const branch: Scenario = {
  name: "branch",
  about: "a branch detached at its join, where one check gives no answer",

  src: `define i64 @f(i64 noundef %x, i64 noundef %y, i1 noundef %c) {
entry:
  br i1 %c, label %left, label %right

left:
  %d = and i64 %x, %y
  %s = sub i64 %x, %d
  br label %join

right:
  %e = add i64 %x, %y
  %g = and i64 %x, %y
  %t = sub i64 %e, %g
  br label %join

join:
  %v = phi i64 [ %s, %left ], [ %t, %right ]
  %q1 = sdiv i64 %v, 3
  %m1 = mul i64 %q1, %v
  %q2 = sdiv i64 %m1, 7
  %m2 = mul i64 %q2, %q1
  ret i64 %m2
}
`,

  tgt: `define i64 @f(i64 noundef %x, i64 noundef %y, i1 noundef %c) {
entry:
  br i1 %c, label %left, label %right

left:
  %d = and i64 %x, %y
  %s = sub i64 %x, %d
  br label %join

right:
  %t = or i64 %x, %y
  br label %join

join:
  %v = phi i64 [ %s, %left ], [ %t, %right ]
  %q1 = sdiv i64 %v, 3
  %m1 = mul i64 %q1, %v
  %q2 = sdiv i64 %m1, 7
  %m2 = mul i64 %q2, %q1
  ret i64 %m2
}
`,

  async prove(session) {
    // `%bb3` is the join on both sides; its phi is `%8` in the src, `%6` in the tgt.
    const split = await session.split("g1", "%bb3", "%bb3", { "%8": "%6" });
    expect("detach the join", split.kind === "split", split);
    if (split.kind !== "split") return;

    const outer = await session.check(split.children.outer);
    expect("the two sides pass the same value", outer.outcome === "proved", outer);
    const callee = await session.check(split.children.callee);
    expect("the chain after the join is the same", callee.outcome === "proved", callee);
  },
};
