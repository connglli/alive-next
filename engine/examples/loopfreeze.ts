// A loop whose tgt drops a freeze of a value the loop never changes.
//
// x is noundef, so freezing it changes nothing, and the tgt drops the freeze.
// Detached at the header, x is a parameter of the callee that may be poison,
// so the callee needs x noundef, proved where the outer calls it and where
// each iteration passes x on to the hypothesis.
import { expect, type Scenario } from "../core/scenario.ts";

export const loopfreeze: Scenario = {
  name: "loopfreeze",
  about: "a loop whose tgt drops a freeze, under a parameter fact every iteration passes on",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n, i32 noundef %x) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %y = freeze i32 %x
  %s.next = add i32 %s, %y
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 noundef %n, i32 noundef %x) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %x
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // i (`%2`), s (`%3`), n (`%0`) and x (`%1`) cross.
    const split = await session.split("g1", "%bb1", "%bb1", {
      "%2": "%2",
      "%3": "%3",
      "%0": "%0",
      "%1": "%1",
    });
    expect("detach the header", split.kind === "split", split);
    if (split.kind !== "split") return;

    const kept = await session.strengthen("g1", { param_attrs: { 3: { noundef: true } } });
    expect("x is noundef on entry and on each iteration", kept.kind === "strengthened", kept);
  },
};
