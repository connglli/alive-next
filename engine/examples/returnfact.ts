// A fact about what a loop returns.
//
// The tgt says the count it returns is never negative, which holds because the
// counter starts at 0 and only grows. The loop's result reaches the outer
// through a call, so a strengthen proves the range of the iteration's src, with
// its hypothesis returning it too, and gives it to the outer's declaration of
// the loop. It rests on i >= 0, which an earlier strengthen proves.
import { expect, type Scenario } from "../core/scenario.ts";

export const returnfact: Scenario = {
  name: "returnfact",
  about: "a range on what a loop returns, proved of its iteration by induction",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %more = icmp slt i32 %i, %n
  br i1 %more, label %body, label %exit

body:
  %i.next = add nsw i32 %i, 1
  br label %loop

exit:
  ret i32 %i
}
`,

  tgt: `define range(i32 0, -2147483648) i32 @f(i32 noundef %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %more = icmp slt i32 %i, %n
  br i1 %more, label %body, label %exit

body:
  %i.next = add nsw i32 %i, 1
  br label %loop

exit:
  ret i32 %i
}
`,

  async prove(session) {
    // `%bb1` is the header: i (`%1`) and n (`%0`) cross, so i is parameter 0.
    const cut = await session.cut("g1", "%bb1", "%bb1", { "%1": "%1", "%0": "%0" });
    expect("detach the header", cut.kind === "cut", cut);
    if (cut.kind !== "cut") return;

    const counted = await session.strengthen("g1", {
      predicates: [{ op: "sge", lhs: "!0", rhs: 0 }],
    });
    expect("count from i >= 0", counted.kind === "strengthened", counted);
    // The range holds of an iteration that starts with i >= 0, and the
    // strengthen's own checks settle both goals.
    const returned = await session.strengthen("g1", {
      ret_attrs: { range: { min: 0, max: -2147483648 } },
    });
    expect("return the range", returned.kind === "strengthened", returned);
  },
};
