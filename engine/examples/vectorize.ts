// Four factors multiplied one at a time, and the same four multiplied in a
// vector: the shape a vectorizer leaves behind, and the one alive2 will not
// answer whole. Nothing here is large. What makes it hard is that a mask and a
// chain of `nsw` multiplies end up in one query, and the two together are more
// than the solver will do at any budget worth waiting for.
//
// The proof takes them apart. Each side gets one rewrite, and after the two the
// pair is close enough that the check following the second step discharges it.
//
// The two steps are also the two ways a step is asked about, which is why this
// example is worth keeping. The src rewrite is two instructions of ten and is
// certified from the window it touched, in about a second; asked as a whole
// function it does not come back at four minutes. The tgt rewrite is the other
// way round: nothing about it is local, since moving the mask out of the vector
// changes what every lane after it reads, so the window settles nothing and the
// whole function answers instead.
//
// The store holds canonical text, so values are named by slot: `%0` to `%3` are
// the parameters and the body starts at `%4`.
import type { EditOp } from "../core/drivers/llops.ts";
import { expect, type Scenario } from "../core/scenario.ts";

export const vectorize: Scenario = {
  name: "vectorize",
  about: "a masked field and a chain of multiplies, gathered into one vector",

  src: `define i32 @fun(i32 %p0, i32 %p1, i32 %p2, i32 %p3) {
entry:
  %v0 = lshr i32 %p0, 22
  %v1 = and i32 %p1, 4190208
  %v2 = ashr i32 %v1, 12
  %v3 = add nsw i32 %v0, 1
  %v4 = add nsw i32 %v2, 1
  %v5 = mul nsw i32 %v3, %v4
  %v6 = add nsw i32 %p2, 1
  %v7 = mul nsw i32 %v5, %v6
  %v8 = add nsw i32 %p3, 1
  %v9 = mul nsw i32 %v7, %v8
  ret i32 %v9
}
`,

  tgt: `declare i32 @llvm.vector.reduce.mul.v4i32(<4 x i32>)

define i32 @fun(i32 %p0, i32 %p1, i32 %p2, i32 %p3) {
entry:
  %v1 = lshr i32 %p1, 12
  %v0 = lshr i32 %p0, 22
  %a = insertelement <4 x i32> poison, i32 %p2, i64 0
  %b = insertelement <4 x i32> %a, i32 %v0, i64 1
  %c = insertelement <4 x i32> %b, i32 %v1, i64 2
  %d = insertelement <4 x i32> %c, i32 %p3, i64 3
  %e = and <4 x i32> %d, <i32 -1, i32 -1, i32 1023, i32 -1>
  %f = add nsw <4 x i32> %e, splat (i32 1)
  %g = tail call i32 @llvm.vector.reduce.mul.v4i32(<4 x i32> %f)
  ret i32 %g
}
`,

  async prove(session) {
    // The tgt masks lane two inside the vector, where it sits between the
    // multiplies and the field the src masks by hand. Mask the lane on its way
    // in instead, and the vector `and` has nothing left to do.
    await session.begin("g1", "tgt");
    const gathering: EditOp[] = [
      { op: "insert", where: "after", w: "%4", insts: ["%m = and i32 %4, 1023"] },
      { op: "replace", v: "%8", insts: ["%8 = insertelement <4 x i32> %7, i32 %m, i64 2"] },
      { op: "substitute", a: "%10", b: "%9" },
      { op: "erase", v: "%10" },
    ];
    for (const op of gathering) {
      const edited = await session.edit(op);
      expect(`the tgt takes ${op.op}`, edited.kind === "applied", edited);
    }
    const moved = await session.commit();
    expect("move the mask out of the vector", moved.kind === "certified", moved);

    // The src reaches the same field the long way, masking in place and
    // shifting after. Shift first and mask what is left, which is what the tgt
    // now does, and the two sides say the same thing about that lane.
    await session.begin("g1", "src");
    const masking: EditOp[] = [
      { op: "replace", v: "%5", insts: ["%s = lshr i32 %1, 12"] },
      { op: "replace", v: "%5", insts: ["%t = and i32 %s, 1023"] },
    ];
    for (const op of masking) {
      const edited = await session.edit(op);
      expect("the src moves its mask", edited.kind === "applied", edited);
    }
    // Nothing follows this: the pair is now near enough that the check after
    // the step settles the goal.
    const masked = await session.commit();
    expect("mask the src field the same way", masked.kind === "certified", masked);
  },
};
