// A loop whose tgt stops on a counter the src does not have.
//
// d counts the odd numbers below n. The tgt if-converts the branch, adds nuw
// twice, and stops when a new value, left, reaches 0: it starts at n and goes
// down by 1 each time around. Detached at the header, the callee takes i, j,
// n and left, and the src passes poison for left, since it has no value to
// pass. Two src steps then pass the src's own value of left, n - i, where the
// outer calls the loop and where the loop calls its hypothesis; each is
// certified because a value refines poison. The invariant says that left is
// n - i, that j <= i and that i <= n. With it, left reaching 0 is i reaching
// n, and both goals prove.
import { expect, type Scenario } from "../core/scenario.ts";

export const countdown: Scenario = {
  name: "countdown",
  about: "a loop whose tgt stops on a counter the src does not have",
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
  %left = phi i32 [ %n, %entry ], [ %left.next, %body ]
  %done = icmp eq i32 %left, 0
  br i1 %done, label %exit, label %body

body:
  %odd = and i32 %i, 1
  %even = icmp eq i32 %odd, 0
  %inc = zext i1 %even to i32
  %j.next = add i32 %j, %inc
  %i.next = add nuw i32 %i, 1
  %left.next = add i32 %left, -1
  br label %head

exit:
  %d = sub nuw i32 %i, %j
  ret i32 %d
}
`,

  async prove(session) {
    // `%bb1` is the header. Its phis `%1` (i) and `%2` (j) and the bound `%0`
    // (n) cross, and so does the tgt's phi `%3` (left), under a key that is
    // not a src value.
    const split = await session.split("g1", "%bb1", "%bb1", {
      "%1": "%1",
      "%2": "%2",
      "%0": "%0",
      left: "%3",
    });
    expect(
      "detach the header",
      split.kind === "split" && split.detach?.hypothesis !== undefined,
      split,
    );
    if (split.kind !== "split" || split.detach?.hypothesis === undefined) return;
    const { callee } = split;
    const { hypothesis } = split.detach;

    // The outer's src calls the loop as `%1`, passing poison for left.
    await session.begin("g2", "src");
    const enter = await session.edit({
      op: "replace",
      v: "%1",
      insts: [`%r = call i32 @${callee}(i32 0, i32 0, i32 %0, i32 %0)`],
    });
    expect("pass n for left", enter.kind === "applied", enter);
    const entered = await session.commit();
    expect("left starts at n", entered.kind === "certified", entered);

    // The loop's src calls its hypothesis as `%11`, passing poison for left,
    // with the next i in `%10` and the next j in `%9`.
    await session.begin("g3", "src");
    const next = await session.edit({
      op: "replace",
      v: "%11",
      insts: [
        "%left = sub i32 %2, %10",
        `%r = call i32 @${hypothesis}(i32 %10, i32 %9, i32 %2, i32 %left)`,
      ],
    });
    expect("pass n - i for left", next.kind === "applied", next);
    const passed = await session.commit();
    expect("left is n - i on the next iteration", passed.kind === "certified", passed);

    // Parameters 0 to 3 are i, j, n and left.
    const kept = await session.strengthen("g1", {
      predicates: [
        { op: "ule", lhs: "!1", rhs: "!0" },
        { op: "ule", lhs: "!0", rhs: "!2" },
        { insts: ["%rest = sub i32 !2, !0", "%ok = icmp eq i32 !3, %rest"] },
      ],
    });
    expect(
      "the invariant holds on entry and each iteration keeps it",
      kept.kind === "strengthened",
      kept,
    );
  },
};
