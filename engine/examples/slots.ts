// A loop that keeps its state in stack slots, as -O0 code does.
//
// The tgt is the src after mem2reg, which keeps the counter and the sum in
// phis. Detached at its header, the src passes what each slot holds rather
// than its address, and the callee stores it in a slot of its own, so both
// sides pass the counter, the sum and the bound, and each half proves alone.
import { expect, type Scenario } from "../core/scenario.ts";

export const slots: Scenario = {
  name: "slots",
  about: "a loop that keeps its state in stack slots, cut by what the slots hold",
  verdict: "verified",

  src: `define i32 @f(i32 %n) {
entry:
  %i = alloca i32, align 4
  %s = alloca i32, align 4
  store i32 0, ptr %i, align 4
  store i32 0, ptr %s, align 4
  br label %loop

loop:
  %0 = load i32, ptr %i, align 4
  %c = icmp slt i32 %0, %n
  br i1 %c, label %body, label %exit

body:
  %1 = load i32, ptr %s, align 4
  %2 = load i32, ptr %i, align 4
  %3 = add nsw i32 %1, %2
  store i32 %3, ptr %s, align 4
  %4 = add nsw i32 %2, 1
  store i32 %4, ptr %i, align 4
  br label %loop

exit:
  %5 = load i32, ptr %s, align 4
  ret i32 %5
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
  %s.next = add nsw i32 %s, %i
  %i.next = add nsw i32 %i, 1
  br label %loop

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // The slots of i (`%1`) and s (`%2`) cross by what they hold, paired with
    // the tgt's phis `%2` and `%1`, and n (`%0`) as itself.
    const split = await session.split("g1", "%bb1", "%bb1", { "%1": "%2", "%2": "%1", "%0": "%0" });
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
