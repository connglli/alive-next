// A loop whose body branches, if-converted in the tgt.
//
// The src counts the even numbers below n through a branch in the loop body,
// which the tgt turns into a zext and an add; the tgt also marks the flags of
// `loop`. Detached at its header, the callee branches without looping, so
// alive-tv proves the if-conversion and the flags together, under j <= i.
import { expect, type Scenario } from "../core/scenario.ts";

export const loopbranch: Scenario = {
  name: "loopbranch",
  about: "a loop whose branching body the tgt if-converts, proved with an invariant",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %latch ]
  %j = phi i32 [ 0, %entry ], [ %j.next, %latch ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %odd = and i32 %i, 1
  %even = icmp eq i32 %odd, 0
  br i1 %even, label %hit, label %latch

hit:
  %j.inc = add i32 %j, 1
  br label %latch

latch:
  %j.next = phi i32 [ %j.inc, %hit ], [ %j, %body ]
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
  %d = sub nuw i32 %i, %j
  ret i32 %d
}
`,

  async prove(session) {
    // `%bb1` is the header on both sides; i (`%1`), j (`%2`) and n (`%0`) cross.
    const split = await session.split("g1", "%bb1", "%bb1", { "%1": "%1", "%2": "%2", "%0": "%0" });
    expect("detach the header", split.kind === "split", split);
    if (split.kind !== "split") return;

    // j <=u i, parameter 1 against parameter 0.
    const kept = await session.strengthen("g1", {
      predicates: [{ op: "ule", lhs: { arg: 1 }, rhs: { arg: 0 } }],
    });
    expect(
      "the invariant holds on entry and each iteration keeps it",
      kept.kind === "strengthened",
      kept,
    );
  },
};
