// A loop behind a guard, the shape LLVM's loop passes leave.
//
// The tgt marks the increment nuw, which holds because the loop only runs
// while i < n. The exit is reached from the guard as well as from the loop,
// so the header cannot be detached until the exit is: detaching the exit
// first turns both branches to it into calls. The invariant i < n then holds
// where the outer calls the loop, which the guard only reaches for n != 0,
// and each iteration keeps it, since the loop goes on only while i + 1 < n.
import { expect, type Scenario } from "../core/scenario.ts";

export const rotated: Scenario = {
  name: "rotated",
  about: "a loop behind a guard, detached at its exit and then at its header",
  verdict: "verified",

  src: `define i32 @g(i32 noundef %n) {
entry:
  %guard = icmp eq i32 %n, 0
  br i1 %guard, label %exit, label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %acc = phi i32 [ 0, %entry ], [ %acc.next, %loop ]
  %acc.next = add i32 %acc, %i
  %i.next = add i32 %i, 1
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit

exit:
  %r = phi i32 [ 0, %entry ], [ %acc.next, %loop ]
  ret i32 %r
}
`,

  tgt: `define i32 @g(i32 noundef %n) {
entry:
  %guard = icmp eq i32 %n, 0
  br i1 %guard, label %exit, label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %acc = phi i32 [ 0, %entry ], [ %acc.next, %loop ]
  %acc.next = add i32 %acc, %i
  %i.next = add nuw i32 %i, 1
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit

exit:
  %r = phi i32 [ 0, %entry ], [ %acc.next, %loop ]
  ret i32 %r
}
`,

  async prove(session) {
    // `%bb2` is the exit, and its phi `%7` crosses.
    const exit = await session.split("g1", "%bb2", "%bb2", { "%7": "%7" });
    expect("detach the exit", exit.kind === "split", exit);
    if (exit.kind !== "split") return;

    // In the outer, `%bb1` is the header: i (`%2`), acc (`%3`) and n (`%0`) cross.
    const header = await session.split(exit.children.outer, "%bb1", "%bb1", {
      "%2": "%2",
      "%3": "%3",
      "%0": "%0",
    });
    expect("detach the header", header.kind === "split" && header.hypothesis !== undefined, header);
    if (header.kind !== "split") return;

    // i <u n, parameter 0 against parameter 2.
    const kept = await session.strengthen(exit.children.outer, {
      predicates: [{ op: "ult", lhs: { arg: 0 }, rhs: { arg: 2 } }],
    });
    expect(
      "the invariant holds on entry and each iteration keeps it",
      kept.kind === "strengthened",
      kept,
    );

    const done = await session.check(exit.children.callee);
    expect("what follows the loop is the same", done.outcome === "proved", done);
  },
};
