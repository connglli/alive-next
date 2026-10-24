// An invariant of a loop that holds a loop.
//
// The tgt's zext nneg needs the outer counter to be nonnegative, which holds by
// induction over the outer loop. Its iteration runs the inner loop, so the
// strengthen interposes the callee goal: the obligation that an iteration keeps
// the fact cuts the inner loop and carries the fact through it, and the rest
// cuts the inner loop and needs nothing more.
import { expect, type Scenario } from "../core/scenario.ts";

export const nestedinvariant: Scenario = {
  name: "nestedinvariant",
  about: "an invariant of a loop that holds a loop, kept in its iteration's interposed goal",
  verdict: "verified",

  src: `define i64 @f(i32 noundef %n, i32 noundef %m) {
entry:
  br label %outer

outer:
  %i = phi i32 [ 0, %entry ], [ %i.next, %latch ]
  %s = phi i64 [ 0, %entry ], [ %t, %latch ]
  %more = icmp slt i32 %i, %n
  br i1 %more, label %body, label %exit

body:
  %k = sext i32 %i to i64
  br label %inner

inner:
  %j = phi i32 [ 0, %body ], [ %j.next, %step ]
  %t = phi i64 [ %s, %body ], [ %t.next, %step ]
  %go = icmp slt i32 %j, %m
  br i1 %go, label %step, label %latch

step:
  %t.next = add i64 %t, %k
  %j.next = add nsw i32 %j, 1
  br label %inner

latch:
  %i.next = add nsw i32 %i, 1
  br label %outer

exit:
  ret i64 %s
}
`,

  tgt: `define i64 @f(i32 noundef %n, i32 noundef %m) {
entry:
  br label %outer

outer:
  %i = phi i32 [ 0, %entry ], [ %i.next, %latch ]
  %s = phi i64 [ 0, %entry ], [ %t, %latch ]
  %more = icmp slt i32 %i, %n
  br i1 %more, label %body, label %exit

body:
  %k = zext nneg i32 %i to i64
  br label %inner

inner:
  %j = phi i32 [ 0, %body ], [ %j.next, %step ]
  %t = phi i64 [ %s, %body ], [ %t.next, %step ]
  %go = icmp slt i32 %j, %m
  br i1 %go, label %step, label %latch

step:
  %t.next = add i64 %t, %k
  %j.next = add nsw i32 %j, 1
  br label %inner

latch:
  %i.next = add nsw i32 %i, 1
  br label %outer

exit:
  ret i64 %s
}
`,

  async prove(session) {
    // `%bb1` is the outer header: i (`%2`), s (`%3`), n (`%0`) and m (`%1`)
    // cross, so i is the callee's parameter 0.
    const outer = await session.cut("g1", "%bb1", "%bb1", {
      "%2": "%2",
      "%3": "%3",
      "%0": "%0",
      "%1": "%1",
    });
    expect("detach the outer header", outer.kind === "cut", outer);
    if (outer.kind !== "cut") return;

    const strengthened = await session.strengthen("g1", {
      predicates: [{ op: "sge", lhs: "!0", rhs: 0 }],
    });
    expect("strengthen with i >= 0", strengthened.kind === "strengthened", strengthened);
    if (strengthened.kind !== "strengthened") return;
    const between = strengthened.effects.find((effect) => effect.effect === "interpose");
    expect("the iteration is interposed", between?.effect === "interpose", strengthened);
    if (between?.effect !== "interpose") return;

    // In the iteration `%bb3` is the inner header: j (`%7`) and t (`%8`)
    // cross, with the widened i (`%6`), i (`%0`), n (`%2`) and m (`%3`).
    const map = { "%7": "%7", "%8": "%8", "%6": "%6", "%0": "%0", "%2": "%2", "%3": "%3" };
    const obligation = await session.cut(between.lhs.gid, "%bb3", "%bb3", map);
    expect("detach the obligation's inner header", obligation.kind === "cut", obligation);
    if (obligation.kind !== "cut") return;
    // The inner loop carries i >= 0 and i < n, so i + 1 at its exit neither
    // wraps nor turns negative. The strengthen's own checks settle both goals.
    const carried = await session.strengthen(between.lhs.gid, {
      predicates: [
        { op: "sge", lhs: "!3", rhs: 0 },
        { op: "slt", lhs: "!3", rhs: "!4" },
      ],
    });
    expect("carry the fact through the inner loop", carried.kind === "strengthened", carried);

    const rest = await session.cut(between.rhs.gid, "%bb3", "%bb3", map);
    expect("detach the rest's inner header", rest.kind === "cut", rest);
    if (rest.kind !== "cut") return;
    for (const gid of [rest.children.outer, rest.children.callee]) {
      const checked = await session.check(gid);
      expect(`check ${gid}`, checked.outcome === "proved", checked);
    }
  },
};
