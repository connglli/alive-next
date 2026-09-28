// A loop whose tgt tests its exit with != instead of <.
//
// i starts at 0 and steps by 1 while i < n, so i never passes n and the two
// tests agree on every iteration a run reaches. The callee after detaching
// the header starts from any i, where they do not agree (i = 2, n = 1), so it
// needs i <= n, which holds on entry and which each iteration keeps.
import { expect, type Scenario } from "../core/scenario.ts";

export const exitcond: Scenario = {
  name: "exitcond",
  about: "a loop whose tgt tests its exit with != instead of <, under the invariant i <= n",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %i
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
  %c = icmp ne i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %i
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // i (`%1`), s (`%2`) and n (`%0`) cross.
    const split = await session.split("g1", "%bb1", "%bb1", { "%1": "%1", "%2": "%2", "%0": "%0" });
    expect("detach the header", split.kind === "split", split);
    if (split.kind !== "split") return;

    // i <=u n, parameter 0 against parameter 2.
    const kept = await session.strengthen("g1", {
      predicates: [{ op: "ule", lhs: { arg: 0 }, rhs: { arg: 2 } }],
    });
    expect(
      "the invariant holds on entry and each iteration keeps it",
      kept.kind === "strengthened",
      kept,
    );
  },
};
