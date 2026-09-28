// `vectorize` as a loop body: a masked field and a chain of multiplies,
// gathered into one vector on the tgt side.
//
// Detached at its header, the callee is one iteration, and alive-tv given
// two minutes on it answers nothing, as it answers nothing on `vectorize`
// whole. The two steps that prove `vectorize` prove it here, inside a body
// of several blocks: the tgt moves its mask out of the vector, asked about
// the whole callee in under a second; the src masks its field the tgt's way,
// which asked about the whole callee does not come back in two minutes and
// is certified from the two instructions it touched. After both, the check
// that follows settles the callee.
import type { EditOp } from "../core/drivers/llops.ts";
import { expect, type Scenario } from "../core/scenario.ts";

export const loopvector: Scenario = {
  name: "loopvector",
  about: "a vectorized loop body, proved by two transactions inside its one iteration",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n, i32 noundef %a, i32 noundef %b, i32 noundef %c) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %go = icmp ult i32 %i, %n
  br i1 %go, label %body, label %exit

body:
  %v0 = lshr i32 %i, 22
  %v1 = and i32 %a, 4190208
  %v2 = ashr i32 %v1, 12
  %v3 = add nsw i32 %v0, 1
  %v4 = add nsw i32 %v2, 1
  %v5 = mul nsw i32 %v3, %v4
  %v6 = add nsw i32 %b, 1
  %v7 = mul nsw i32 %v5, %v6
  %v8 = add nsw i32 %c, 1
  %p = mul nsw i32 %v7, %v8
  %s.next = add i32 %s, %p
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  tgt: `declare i32 @llvm.vector.reduce.mul.v4i32(<4 x i32>)

define i32 @f(i32 noundef %n, i32 noundef %a, i32 noundef %b, i32 noundef %c) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %go = icmp ult i32 %i, %n
  br i1 %go, label %body, label %exit

body:
  %w1 = lshr i32 %a, 12
  %w0 = lshr i32 %i, 22
  %x0 = insertelement <4 x i32> poison, i32 %b, i64 0
  %x1 = insertelement <4 x i32> %x0, i32 %w0, i64 1
  %x2 = insertelement <4 x i32> %x1, i32 %w1, i64 2
  %x3 = insertelement <4 x i32> %x2, i32 %c, i64 3
  %e = and <4 x i32> %x3, <i32 -1, i32 -1, i32 1023, i32 -1>
  %f = add nsw <4 x i32> %e, splat (i32 1)
  %p = tail call i32 @llvm.vector.reduce.mul.v4i32(<4 x i32> %f)
  %s.next = add i32 %s, %p
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // i (`%4`), s (`%5`), n, a, b and c (`%0` to `%3`) cross.
    const split = await session.split("g1", "%bb1", "%bb1", {
      "%4": "%4",
      "%5": "%5",
      "%0": "%0",
      "%1": "%1",
      "%2": "%2",
      "%3": "%3",
    });
    expect("detach the header", split.kind === "split", split);
    if (split.kind !== "split") return;
    const callee = split.children.callee;

    // In the callee `%7` is the tgt's field, `%11` its lane-two insert, and
    // `%13` the vector `and` that masks it; `%12` is the vector before it.
    await session.begin(callee, "tgt");
    const gathering: EditOp[] = [
      { op: "insert", where: "after", w: "%7", insts: ["%m = and i32 %7, 1023"] },
      { op: "replace", v: "%11", insts: ["%11 = insertelement <4 x i32> %10, i32 %m, i64 2"] },
      { op: "substitute", a: "%13", b: "%12" },
      { op: "erase", v: "%13" },
    ];
    for (const op of gathering) {
      const edited = await session.edit(op);
      expect(`the tgt takes ${op.op}`, edited.kind === "applied", edited);
    }
    const moved = await session.commit();
    expect("move the mask out of the vector", moved.kind === "certified", moved);

    // `%8` is the src's `and` of a; once it is a shift, the `ashr` after it
    // is `%8` in turn.
    await session.begin(callee, "src");
    const masking: EditOp[] = [
      { op: "replace", v: "%8", insts: ["%s = lshr i32 %3, 12"] },
      { op: "replace", v: "%8", insts: ["%t = and i32 %s, 1023"] },
    ];
    for (const op of masking) {
      const edited = await session.edit(op);
      expect("the src moves its mask", edited.kind === "applied", edited);
    }
    const masked = await session.commit();
    expect("mask the src field the same way", masked.kind === "certified", masked);

    const outer = await session.check(split.children.outer);
    expect("the loop is entered the same way", outer.outcome === "proved", outer);
  },
};
