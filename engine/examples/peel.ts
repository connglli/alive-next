// A loop the tgt peels, proved by unfolding the src's outer.
//
// s starts at a and adds each i below n, except that i = 0 adds 100. The tgt
// runs the first iteration before its loop, which starts at i = 1 and does
// not test for i = 0. Cut at their headers, the src's outer calls the loop at
// i = 0 and the tgt's at i = 1; unfolding the src's outer makes it run the
// first iteration too. The invariant i != 0 then makes the src's test always
// false. The tgt's exit is also reached from before its loop, so the exit is
// cut first, as in `rotated`.
import { expect, type Scenario } from "../core/scenario.ts";

export const peel: Scenario = {
  name: "peel",
  about: "a loop the tgt peels, proved by unfolding the src's outer",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %a, i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ %a, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %first = icmp eq i32 %i, 0
  %x = select i1 %first, i32 100, i32 %i
  %s.next = add i32 %s, %x
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 noundef %a, i32 noundef %n) {
entry:
  %any = icmp ne i32 %n, 0
  br i1 %any, label %peel, label %exit

peel:
  %s.peel = add i32 %a, 100
  br label %head

head:
  %i = phi i32 [ 1, %peel ], [ %i.next, %body ]
  %s = phi i32 [ %s.peel, %peel ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %i
  %i.next = add i32 %i, 1
  br label %head

exit:
  %r = phi i32 [ %a, %entry ], [ %s, %head ]
  ret i32 %r
}
`,

  async prove(session) {
    // The exits are the src's `%bb2` and the tgt's `%bb3`. What they return,
    // s (`%3`) and the tgt's phi `%7`, crosses.
    const exit = await session.split("g1", "%bb2", "%bb3", { "%3": "%7" });
    expect("detach the exit", exit.kind === "split", exit);
    if (exit.kind !== "split") return;

    // In the outer, the headers are the src's `%bb1` and the tgt's `%bb3`:
    // i (`%2`, `%5`), s (`%3`, `%6`) and n (`%1`) cross.
    const header = await session.split(exit.children.outer, "%bb1", "%bb3", {
      "%2": "%5",
      "%3": "%6",
      "%1": "%1",
    });
    expect(
      "detach the header",
      header.kind === "split" && header.detach?.hypothesis !== undefined,
      header,
    );
    if (header.kind !== "split") return;

    const peeled = await session.unfold(header.children.outer, "src");
    expect("run the src's first iteration in its outer", peeled.kind === "certified", peeled);

    // i != 0, parameter 0.
    const kept = await session.strengthen(exit.children.outer, {
      predicates: [{ op: "ne", lhs: "!0", rhs: 0 }],
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
