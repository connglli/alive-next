// A loop proved by induction, with the invariant it keeps.
//
// j counts the even numbers below n and i all of them, so j <= i on every
// iteration, and the tgt marks the final sub nuw on the strength of it. The
// loop cannot be checked whole: detached at its header, the callee is one
// iteration, its back edge a call of the hypothesis. That callee is refuted
// on its own at i = 0, j = 8, a state no run reaches; the invariant is what
// says so. Strengthening proves it where the outer calls the loop (it holds
// on entry) and where the loop calls its hypothesis (each iteration keeps
// it), and assumes it at the callee's entry, after which both goals prove.
import { expect, type Scenario } from "../core/scenario.ts";

export const loop: Scenario = {
  name: "loop",
  about: "a loop proved by induction with the invariant it keeps",
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
  %d = sub nuw i32 %i, %j
  ret i32 %d
}
`,

  async prove(session) {
    // `%bb1` is the header; its phis `%1` (i) and `%2` (j) and the bound `%0`
    // (n) cross, in that order.
    const split = await session.split("g1", "%bb1", "%bb1", { "%1": "%1", "%2": "%2", "%0": "%0" });
    expect(
      "detach the header",
      split.kind === "split" && split.detach?.hypothesis !== undefined,
      split,
    );
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
