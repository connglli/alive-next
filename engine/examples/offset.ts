// A loop the tgt reads through a byte offset, proved by cutting at the load.
//
// c counts the elements of a below t. The tgt keeps a byte offset beside i,
// loads from a + off, and if-converts the branch. After the header cut and
// the invariant off == 4 * i, the loop body is too costly to check whole: a
// value loaded at a rewritten address flows into the hypothesis. Cutting the
// body at the load makes the address cross instead, so one goal proves the
// two addresses equal and the other loads through the same pointer.
import { expect, type Scenario } from "../core/scenario.ts";

export const offset: Scenario = {
  name: "offset",
  about: "a loop the tgt reads through a byte offset, proved by cutting at the load",
  verdict: "verified",

  src: `define i32 @f(ptr noundef %a, i32 noundef %n, i32 noundef %t) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %latch ]
  %c = phi i32 [ 0, %entry ], [ %c.next, %latch ]
  %more = icmp ult i32 %i, %n
  br i1 %more, label %body, label %exit

body:
  %idx = zext i32 %i to i64
  %p = getelementptr inbounds i32, ptr %a, i64 %idx
  %v = load i32, ptr %p, align 4
  %lt = icmp slt i32 %v, %t
  br i1 %lt, label %hit, label %latch

hit:
  %c.inc = add i32 %c, 1
  br label %latch

latch:
  %c.next = phi i32 [ %c.inc, %hit ], [ %c, %body ]
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %c
}
`,

  tgt: `define i32 @f(ptr noundef %a, i32 noundef %n, i32 noundef %t) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %c = phi i32 [ 0, %entry ], [ %c.next, %body ]
  %off = phi i64 [ 0, %entry ], [ %off.next, %body ]
  %more = icmp ult i32 %i, %n
  br i1 %more, label %body, label %exit

body:
  %p = getelementptr inbounds i8, ptr %a, i64 %off
  %v = load i32, ptr %p, align 4
  %lt = icmp slt i32 %v, %t
  %inc = zext i1 %lt to i32
  %c.next = add i32 %c, %inc
  %i.next = add i32 %i, 1
  %off.next = add i64 %off, 4
  br label %head

exit:
  ret i32 %c
}
`,

  async prove(session) {
    // `%bb1` is the header. i (`%3`), c (`%4`), a, n and t cross, and so does
    // the tgt's offset (`%5`), which the src does not have.
    const header = await session.split("g1", "%bb1", "%bb1", {
      "%3": "%3",
      "%4": "%4",
      "%0": "%0",
      "%1": "%1",
      "%2": "%2",
      off: "%5",
    });
    expect("detach the header", header.kind === "split", header);
    if (header.kind !== "split" || header.detach?.hypothesis === undefined) return;
    const loop = header.children.callee;

    // The src passes poison for the offset: 0 where the outer calls the loop
    // (`%3`), and 4 * (i + 1) where the loop calls its hypothesis (`%14`).
    await session.begin(header.children.outer, "src");
    await session.edit({
      op: "replace",
      v: "%3",
      insts: [`%r = call i32 @${header.callee}(i32 0, i32 0, ptr %0, i32 %1, i32 %2, i64 0)`],
    });
    const entered = await session.commit();
    expect("the offset starts at 0", entered.kind === "certified", entered);
    await session.begin(loop, "src");
    await session.edit({
      op: "replace",
      v: "%14",
      insts: [
        "%w = zext i32 %13 to i64",
        "%o = shl i64 %w, 2",
        `%r = call i32 @${header.detach.hypothesis}(i32 %13, i32 %12, ptr %2, i32 %3, i32 %4, i64 %o)`,
      ],
    });
    const next = await session.commit();
    expect("the offset is 4 * i on the next iteration", next.kind === "certified", next);

    // off == 4 * i, parameter 5 against parameter 0.
    const kept = await session.strengthen("g1", {
      predicates: [
        {
          insts: [
            "%w = zext i32 !0 to i64",
            "%four = shl i64 %w, 2",
            "%ok = icmp eq i64 !5, %four",
          ],
        },
      ],
    });
    expect("the offset is 4 * i on entry and each iteration", kept.kind === "strengthened", kept);

    // Cut the body at the load, the src's `%12` and the tgt's `%11`: the
    // address crosses (`%11` and `%10`), and the tgt's offset with it.
    const cut = await session.split(loop, "%12", "%11", {
      "%11": "%10",
      "%4": "%4",
      "%1": "%1",
      "%0": "%0",
      "%2": "%2",
      "%3": "%3",
      off: "%5",
    });
    expect("cut the body at the load", cut.kind === "split", cut);
    if (cut.kind !== "split") return;

    // The src passes poison for the offset into the rest (`%12`); it has it as `%5`.
    await session.begin(cut.children.outer, "src");
    await session.edit({
      op: "replace",
      v: "%12",
      insts: [
        `%r = call i32 @${cut.callee}(ptr %11, i32 %0, i32 %1, ptr %2, i32 %3, i32 %4, i64 %5)`,
      ],
    });
    const passed = await session.commit();
    expect("pass the offset into the rest", passed.kind === "certified", passed);

    // The rest needs off == 4 * i (parameters 6 and 1) and i < n (1 and 4).
    const known = await session.strengthen(loop, {
      predicates: [
        {
          insts: [
            "%w = zext i32 !1 to i64",
            "%four = shl i64 %w, 2",
            "%ok = icmp eq i64 !6, %four",
          ],
        },
        { op: "ult", lhs: "!1", rhs: "!4" },
      ],
    });
    expect("the rest knows the offset and the bound", known.kind === "strengthened", known);

    for (const gid of [cut.children.outer, cut.children.callee]) {
      const checked = await session.check(gid);
      expect(`check ${gid}`, checked.outcome === "proved", checked);
    }
  },
};
