// Proving a large translation by strengthening with relational predicates.
//
// Monolithic single-query SMT times out on this program because bitwise
// masking, arithmetic offset calculations, and multiplication combine into an
// intractable search space across three input variables (%x, %y, %step).
//
// Decomposition cuts the program into an outer coordinate setup and an
// inner scaled offset computation. In the prefix:
//   %lo = and i32 %x, 255          ; bounded to [0, 255]
//   %hi = or i32 %lo, 256          ; bounded to [256, 511]
//   %delta = and i32 %step, 15     ; bounded to [0, 15]
//   %limit = add i32 %hi, %delta   ; bounded to [256, 526]
//
// Because %lo <= 255 and %limit >= 256, the caller strictly guarantees %lo < %limit.
//
// In the suffix, the target optimizes a checked clamp:
//   %diff = sub i32 %limit, %lo
//   %cmp = icmp ult i32 %lo, %limit
//   %span = select i1 %cmp, i32 %diff, 0
// into an unchecked, non-wrapping subtraction:
//   %span = sub nuw i32 %limit, %lo
//
// In isolation, the callee goal is false: for arbitrary inputs where %lo >= %limit,
// `sub nuw` underflows and produces poison, whereas the source select safely returns 0.
//
// Strengthening asserts the relational precondition (%lo < %limit) across the cut arguments.
// The framework proves this inequality at the call site in the outer caller, then assumes
// it on entry in the callee, enabling both subgoals to discharge rapidly.
import { expect, type Scenario } from "../core/scenario.ts";

export const predicate: Scenario = {
  name: "predicate",
  about: "strengthening with a relational comparison predicate across cut arguments",

  src: `define i32 @f(i32 noundef %x, i32 noundef %y, i32 noundef %step) {
entry:
  %lo = and i32 %x, 255
  %hi = or i32 %lo, 256
  %delta = and i32 %step, 15
  %limit = add i32 %hi, %delta
  %scale = mul i32 %y, 8
  %diff = sub i32 %limit, %lo
  %cmp = icmp ult i32 %lo, %limit
  %span = select i1 %cmp, i32 %diff, i32 0
  %scaled = mul i32 %span, %scale
  %offset = add i32 %scaled, %lo
  %clamped = and i32 %offset, 65535
  ret i32 %clamped
}
`,

  tgt: `define i32 @f(i32 noundef %x, i32 noundef %y, i32 noundef %step) {
entry:
  %lo = and i32 %x, 255
  %hi = or i32 %lo, 256
  %delta = and i32 %step, 15
  %limit = add i32 %hi, %delta
  %scale = shl i32 %y, 3
  %span = sub nuw i32 %limit, %lo
  %scaled = mul i32 %span, %scale
  %offset = add i32 %scaled, %lo
  %clamped = and i32 %offset, 65535
  ret i32 %clamped
}
`,

  async prove(session) {
    // Cut before the scale computation (%7 in canonical slot naming).
    // Live values crossing the cut: %lo (%3), %limit (%6), and %y (%1).
    const split = await session.split("g1", "%7", "%7", {
      "%3": "%3",
      "%6": "%6",
      "%1": "%1",
    });
    expect("cut before the scale computation", split.kind === "split", split);
    if (split.kind !== "split") return;

    // Checking the unstrengthened callee reveals why interface strengthening is necessary:
    // without the relation %lo < %limit, target's `sub nuw` is more poisonous than source.
    const unstrengthened = await session.check(split.children.callee);
    if (unstrengthened.check?.outcome === "incorrect") {
      expect(
        "unstrengthened callee is refuted",
        unstrengthened.outcome === "refuted",
        unstrengthened,
      );
      expect(
        "counterexample demonstrates poison divergence",
        unstrengthened.check.detail.includes("Target is more poisonous than source"),
        unstrengthened.check,
      );
    }

    // Strengthen the callee interface:
    // - Parameter attributes: all three live-ins are noundef.
    // - Relational predicate: parameter 0 (%lo) is strictly less than parameter 1 (%limit).
    // Proving the relational precondition (%lo < %limit) in the caller and assuming it on entry
    // in the callee allows session.strengthen to eagerly discharge both subgoals.
    const stronger = await session.strengthen("g1", {
      param_attrs: {
        0: { noundef: true },
        1: { noundef: true },
        2: { noundef: true },
      },
      predicates: [{ op: "ult", lhs: { arg: 0 }, rhs: { arg: 1 } }],
    });
    expect(
      "strengthen interface with relational predicate",
      stronger.kind === "strengthened",
      stronger,
    );

    // The eager check within strengthen proves the outer and callee automatically.
  },
};
