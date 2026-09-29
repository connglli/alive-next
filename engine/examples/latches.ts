// A loop with two latches, proved by induction.
//
// The invariant of the loop scenario, j <= i, on a loop whose body goes back
// to its header along two edges: one counts an even i in j and one does not.
// Detached at the header, the callee calls its hypothesis once per latch, so
// one iteration has to keep the invariant before both calls.
import { expect, type Scenario } from "../core/scenario.ts";

export const latches: Scenario = {
  name: "latches",
  about: "a loop with two latches proved by induction",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.even, %even ], [ %i.odd, %odd ]
  %j = phi i32 [ 0, %entry ], [ %j.even, %even ], [ %j, %odd ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %bit = and i32 %i, 1
  %isodd = icmp ne i32 %bit, 0
  br i1 %isodd, label %odd, label %even

even:
  %j.even = add i32 %j, 1
  %i.even = add i32 %i, 1
  br label %head

odd:
  %i.odd = add i32 %i, 1
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
  %i = phi i32 [ 0, %entry ], [ %i.even, %even ], [ %i.odd, %odd ]
  %j = phi i32 [ 0, %entry ], [ %j.even, %even ], [ %j, %odd ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %bit = and i32 %i, 1
  %isodd = icmp ne i32 %bit, 0
  br i1 %isodd, label %odd, label %even

even:
  %j.even = add i32 %j, 1
  %i.even = add i32 %i, 1
  br label %head

odd:
  %i.odd = add i32 %i, 1
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
      predicates: [{ op: "ule", lhs: "!1", rhs: "!0" }],
    });
    expect(
      "the invariant holds on entry and each iteration keeps it along both latches",
      kept.kind === "strengthened",
      kept,
    );
  },
};
