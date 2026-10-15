// A loop that keeps its state in stack slots, as -O0 code does.
//
// The tgt is the src after mem2reg, which keeps the counter and the sum in
// phis and the doubled counter in neither. Detached at its header, the src
// passes what each slot holds, poison for the one each iteration stores
// before it reads, and the callee copies it, so each half proves alone.
import { expect, type Scenario } from "../core/scenario.ts";

export const slots: Scenario = {
  name: "slots",
  about: "a loop that keeps its state in stack slots, cut by what the slots hold",
  verdict: "verified",

  src: `define i32 @f(i32 %n) {
entry:
  %i = alloca i32, align 4
  %s = alloca i32, align 4
  %t = alloca i32, align 4
  store i32 0, ptr %i, align 4
  store i32 0, ptr %s, align 4
  br label %loop

loop:
  %0 = load i32, ptr %i, align 4
  %c = icmp slt i32 %0, %n
  br i1 %c, label %body, label %exit

body:
  %1 = load i32, ptr %i, align 4
  %2 = mul nsw i32 %1, 2
  store i32 %2, ptr %t, align 4
  %3 = load i32, ptr %s, align 4
  %4 = load i32, ptr %t, align 4
  %5 = add nsw i32 %3, %4
  store i32 %5, ptr %s, align 4
  %6 = add nsw i32 %1, 1
  store i32 %6, ptr %i, align 4
  br label %loop

exit:
  %7 = load i32, ptr %s, align 4
  ret i32 %7
}
`,

  tgt: `define i32 @f(i32 %n) {
entry:
  br label %loop

loop:
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %c = icmp slt i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %t = mul nsw i32 %i, 2
  %s.next = add nsw i32 %s, %t
  %i.next = add nsw i32 %i, 1
  br label %loop

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // The slots of i (`%1`) and s (`%2`) cross by what they hold, paired with
    // the tgt's phis `%2` and `%1`, the doubled counter's (`%3`) as poison.
    const map = { "%1": "%2", "%2": "%1", "%3": "poison", "%0": "%0" };
    const split = await session.split("g1", "%bb1", "%bb1", map);
    expect(
      "detach the header",
      split.kind === "split" && split.detach?.hypothesis !== undefined,
      split,
    );
    if (split.kind !== "split") return;

    for (const gid of [split.children.outer, split.children.callee]) {
      const checked = await session.check(gid);
      expect(`check ${gid}`, checked.outcome === "proved", checked);
    }
  },
};
