// A loop proved by induction alone.
//
// The tgt marks the increment nuw, which the branch into the body already
// justifies: the loop only runs that increment while i < n. Detached at its
// header, the callee is one iteration with the rest of the loop left to the
// hypothesis, and that iteration proves on its own, with no invariant: the
// call of the hypothesis stands for every later iteration.
import { expect, type Scenario } from "../core/scenario.ts";

export const induction: Scenario = {
  name: "induction",
  about: "a loop proved by induction alone, one iteration at a time",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %j = phi i32 [ 0, %entry ], [ %j.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %odd = and i32 %i, 1
  %even = icmp eq i32 %odd, 0
  %inc = zext i1 %even to i32
  %j.next = add i32 %j, %inc
  %i.next = add i32 %i, 1
  br label %head

exit:
  %d = sub i32 %i, %j
  ret i32 %d
}
`,

  tgt: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %j = phi i32 [ 0, %entry ], [ %j.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %odd = and i32 %i, 1
  %even = icmp eq i32 %odd, 0
  %inc = zext i1 %even to i32
  %j.next = add i32 %j, %inc
  %i.next = add nuw i32 %i, 1
  br label %head

exit:
  %d = sub i32 %i, %j
  ret i32 %d
}
`,

  async prove(session) {
    // `%bb1` is the header; i (`%1`), j (`%2`) and n (`%0`) cross.
    const split = await session.split("g1", "%bb1", "%bb1", { "%1": "%1", "%2": "%2", "%0": "%0" });
    expect(
      "detach the header",
      split.kind === "split" && split.detach?.hypothesis !== undefined,
      split,
    );
    if (split.kind !== "split") return;

    const outer = await session.check(split.children.outer);
    expect("the loop is entered the same way", outer.outcome === "proved", outer);
    const iteration = await session.check(split.children.callee);
    expect("one iteration proves on its own", iteration.outcome === "proved", iteration);
  },
};
