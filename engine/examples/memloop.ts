// A loop that stores on each iteration.
//
// The tgt marks the increment nuw, which the branch into the body justifies,
// as in `induction`. The pointer crosses the cut unchanged, and the callee is
// one iteration's store followed by the hypothesis, which may read and write
// what the store left.
import { expect, type Scenario } from "../core/scenario.ts";

export const memloop: Scenario = {
  name: "memloop",
  about: "a loop that stores on each iteration, proved by induction alone",
  verdict: "verified",

  src: `define void @f(ptr noundef %p, i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %q = getelementptr i32, ptr %p, i32 %i
  store i32 %i, ptr %q, align 4
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret void
}
`,

  tgt: `define void @f(ptr noundef %p, i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %q = getelementptr i32, ptr %p, i32 %i
  store i32 %i, ptr %q, align 4
  %i.next = add nuw i32 %i, 1
  br label %head

exit:
  ret void
}
`,

  async prove(session) {
    // i (`%2`), p (`%0`) and n (`%1`) cross.
    const split = await session.split("g1", "%bb1", "%bb1", { "%2": "%2", "%0": "%0", "%1": "%1" });
    expect("detach the header", split.kind === "split", split);
    if (split.kind !== "split") return;

    for (const gid of [split.children.outer, split.children.callee]) {
      const checked = await session.check(gid);
      expect(`check ${gid}`, checked.outcome === "proved", checked);
    }
  },
};
