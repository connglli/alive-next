// A loop inside a loop, detached one header at a time.
//
// The tgt marks the inner increment nuw, which the inner branch justifies.
// Detaching the outer header leaves a callee that still loops, since it holds
// the inner loop, and a callee that loops cannot be proved. Detaching the
// inner header inside it leaves three goals that do not loop: the entry, one
// iteration of the outer loop up to the inner one, and one iteration of the
// inner loop, whose exit calls the outer loop's hypothesis.
import { expect, type Scenario } from "../core/scenario.ts";

export const nested: Scenario = {
  name: "nested",
  about: "a loop inside a loop, detached at the outer header and then the inner one",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n, i32 noundef %m) {
entry:
  br label %outer

outer:
  %j = phi i32 [ 0, %entry ], [ %j.next, %latch ]
  %s = phi i32 [ 0, %entry ], [ %t, %latch ]
  %cj = icmp ult i32 %j, %n
  br i1 %cj, label %inner, label %exit

inner:
  %i = phi i32 [ 0, %outer ], [ %i.next, %step ]
  %t = phi i32 [ %s, %outer ], [ %t.next, %step ]
  %ci = icmp ult i32 %i, %m
  br i1 %ci, label %step, label %latch

step:
  %t.next = add i32 %t, %i
  %i.next = add i32 %i, 1
  br label %inner

latch:
  %j.next = add i32 %j, 1
  br label %outer

exit:
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 noundef %n, i32 noundef %m) {
entry:
  br label %outer

outer:
  %j = phi i32 [ 0, %entry ], [ %j.next, %latch ]
  %s = phi i32 [ 0, %entry ], [ %t, %latch ]
  %cj = icmp ult i32 %j, %n
  br i1 %cj, label %inner, label %exit

inner:
  %i = phi i32 [ 0, %outer ], [ %i.next, %step ]
  %t = phi i32 [ %s, %outer ], [ %t.next, %step ]
  %ci = icmp ult i32 %i, %m
  br i1 %ci, label %step, label %latch

step:
  %t.next = add i32 %t, %i
  %i.next = add nuw i32 %i, 1
  br label %inner

latch:
  %j.next = add i32 %j, 1
  br label %outer

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // `%bb1` is the outer header: j (`%2`), s (`%3`), n (`%0`) and m (`%1`) cross.
    const outer = await session.split("g1", "%bb1", "%bb1", {
      "%2": "%2",
      "%3": "%3",
      "%0": "%0",
      "%1": "%1",
    });
    expect("detach the outer header", outer.kind === "split", outer);
    if (outer.kind !== "split") return;

    // In that callee `%bb2` is the inner header: i (`%5`) and t (`%6`) cross,
    // with j (`%0`), n (`%2`) and m (`%3`).
    const inner = await session.split(outer.children.callee, "%bb2", "%bb2", {
      "%5": "%5",
      "%6": "%6",
      "%0": "%0",
      "%2": "%2",
      "%3": "%3",
    });
    expect("detach the inner header", inner.kind === "split", inner);
    if (inner.kind !== "split") return;

    for (const gid of [outer.children.outer, inner.children.outer, inner.children.callee]) {
      const checked = await session.check(gid);
      expect(`check ${gid}`, checked.outcome === "proved", checked);
    }
  },
};
