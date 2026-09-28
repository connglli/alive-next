// A loop only a pre-proved rule proves.
//
// Both programs take the alternating sum of n's three-digit groups, which is
// divisible by 7, 11 and 13 exactly when n is, since 1001 = 7 * 11 * 13. The
// src computes each group as `n - (n / 1000) * 1000` and folds the sum into
// the same subtraction; the tgt uses `srem`. Detached at the header, the
// callee is one group, and alive-tv given five minutes on it answers nothing:
// a 64-bit division and a remainder spelled two ways are more than it will
// relate. The verified rewriter's `x - ((x sdiv C) * C + y)` rule turns the
// src into the tgt's text, so the check that follows needs no solver at all.
import { expect, type Scenario } from "../core/scenario.ts";

export const digits: Scenario = {
  name: "digits",
  about: "a loop whose one iteration only a pre-proved rule proves",
  verdict: "verified",

  src: `define i64 @f(i64 noundef %n0) {
entry:
  br label %head

head:
  %n = phi i64 [ %n0, %entry ], [ %q, %body ]
  %s = phi i64 [ 0, %entry ], [ %s.next, %body ]
  %go = icmp ne i64 %n, 0
  br i1 %go, label %body, label %exit

body:
  %q = sdiv i64 %n, 1000
  %m = mul i64 %q, 1000
  %ms = add i64 %m, %s
  %s.next = sub i64 %n, %ms
  br label %head

exit:
  ret i64 %s
}
`,

  tgt: `define i64 @f(i64 noundef %n0) {
entry:
  br label %head

head:
  %n = phi i64 [ %n0, %entry ], [ %q, %body ]
  %s = phi i64 [ 0, %entry ], [ %s.next, %body ]
  %go = icmp ne i64 %n, 0
  br i1 %go, label %body, label %exit

body:
  %q = sdiv i64 %n, 1000
  %d = srem i64 %n, 1000
  %s.next = sub i64 %d, %s
  br label %head

exit:
  ret i64 %s
}
`,

  async prove(session) {
    // n (`%1`) and the sum (`%2`) cross.
    const split = await session.split("g1", "%bb1", "%bb1", { "%1": "%1", "%2": "%2" });
    expect("detach the header", split.kind === "split", split);
    if (split.kind !== "split") return;

    const rewritten = await session.rewrite(split.children.callee, "src", [
      "subi-sdiv-mul-to-srem",
    ]);
    expect("the rule makes one iteration the tgt's", rewritten.kind === "certified", rewritten);
    const outer = await session.check(split.children.outer);
    expect("the loop is entered the same way", outer.outcome === "proved", outer);
  },
};
