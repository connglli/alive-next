// A loop whose tgt reads n where the src reads a phi that copies it.
//
// The src carries n around the loop a second time, in a phi that takes n on
// entry and itself on the back edge; the tgt reads n, and marks the increment
// nuw. Detached at the header, the value map sends both the phi and n to the
// tgt's n, and the callee needs the phi equal to n, which holds on entry and
// which each iteration keeps.
import { expect, type Scenario } from "../core/scenario.ts";

export const copiedphi: Scenario = {
  name: "copiedphi",
  about: "a loop whose tgt reads n where the src reads a phi that copies it",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %k = phi i32 [ %n, %entry ], [ %k, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %k
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %n
  %i.next = add nuw i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // i (`%1`), the phi (`%2`) that the tgt reads as n (`%0`), s and n.
    const split = await session.split("g1", "%bb1", "%bb1", {
      "%1": "%1",
      "%2": "%0",
      "%3": "%2",
      "%0": "%0",
    });
    expect("detach the header", split.kind === "split", split);
    if (split.kind !== "split") return;

    // The phi equals n, parameter 1 against parameter 3.
    const kept = await session.strengthen("g1", {
      predicates: [{ op: "eq", lhs: { arg: 1 }, rhs: { arg: 3 } }],
    });
    expect(
      "the invariant holds on entry and each iteration keeps it",
      kept.kind === "strengthened",
      kept,
    );
  },
};
