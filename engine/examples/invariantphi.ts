// A loop whose tgt drops a phi that never changes.
//
// The src carries x around the loop in a phi that takes x on entry and itself
// on the back edge, which the tgt reads as x, as instsimplify leaves it; the
// tgt also marks the increment nuw. Detached at the header, the phi is a
// parameter of the callee on the src side and x is the same parameter on the
// tgt side, so the certificate has to put the phi back where it was.
import { expect, type Scenario } from "../core/scenario.ts";

export const invariantphi: Scenario = {
  name: "invariantphi",
  about: "a loop whose tgt reads a phi that never changes as the value it holds",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n, i32 noundef %x) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %k = phi i32 [ %x, %entry ], [ %k, %body ]
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
  %i.next = add nuw i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // i (`%2`), the phi (`%3`) that the tgt reads as x (`%1`), s and n.
    const split = await session.split("g1", "%bb1", "%bb1", {
      "%2": "%2",
      "%3": "%1",
      "%4": "%3",
      "%0": "%0",
    });
    expect("detach the header", split.kind === "split", split);
    if (split.kind !== "split") return;

    for (const gid of [split.children.outer, split.children.callee]) {
      const checked = await session.check(gid);
      expect(`check ${gid}`, checked.outcome === "proved", checked);
    }
  },
};
