// A join reached from two branches, strengthened before both calls.
//
// The tgt marks the add after the join nuw nsw, which holds because the value
// reaching it is at most 255 on either branch. Detached at the join, the outer
// calls the callee once from each branch, and the callee on its own is refuted,
// since nothing bounds the value it is given. The range is proved before both
// calls and assumed at the callee's start, after which both goals prove.
import { expect, type Scenario } from "../core/scenario.ts";

export const join: Scenario = {
  name: "join",
  about: "a join strengthened before the call from each branch",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %x, i1 noundef %c) {
entry:
  br i1 %c, label %a, label %b

a:
  %p = and i32 %x, 255
  br label %join

b:
  %q = and i32 %x, 15
  br label %join

join:
  %v = phi i32 [ %p, %a ], [ %q, %b ]
  %r = add i32 %v, 1
  ret i32 %r
}
`,

  tgt: `define i32 @f(i32 noundef %x, i1 noundef %c) {
entry:
  br i1 %c, label %a, label %b

a:
  %p = and i32 %x, 255
  br label %join

b:
  %q = and i32 %x, 15
  br label %join

join:
  %v = phi i32 [ %p, %a ], [ %q, %b ]
  %r = add nuw nsw i32 %v, 1
  ret i32 %r
}
`,

  async prove(session) {
    // `%bb3` is the join; its phi `%4` is the one value that crosses.
    const split = await session.split("g1", "%bb3", "%bb3", { "%4": "%4" });
    expect("detach the join", split.kind === "split", split);
    if (split.kind !== "split") return;

    const bounded = await session.strengthen("g1", {
      param_attrs: { 0: { range: { min: 0, max: 256 } } },
    });
    expect("the range holds before both calls", bounded.kind === "strengthened", bounded);
  },
};
