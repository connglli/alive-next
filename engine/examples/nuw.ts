// Removing a `nuw` (no unsigned wrap) flag from an addition.
//
// The source has `nuw` on `%v2 = add nuw i32 %v1, 1`. Dropping `nuw` is sound
// because the new program is more defined than the old one, and the commit
// names the window it touched and the facts its live-in needs, both as the
// canonical program the commit opens on: `%1` is the `and`, `%2` the `add`.
//
// With `noundef` and `range [0, 256]` on `%1`, the framework:
// 1. Proves whole-function that the precondition holds at the call site (Phase 1).
// 2. Applies the precondition as attributes to the window pair's parameters
//    and certifies the small window (Phase 2).
//
// The preconditions are recorded in the certificate, which is what this
// scenario asserts: a commit that fell back to the plain window would still be
// certified, since the rewrite is sound on its own, but it would not have used
// the conditioned path this scenario exists to exercise.
import { expect, type Scenario } from "../core/scenario.ts";

export const nuw: Scenario = {
  name: "nuw",
  about: "stripping a nuw flag using a conditioned window",

  src: `define i32 @f(i32 noundef %x) {
entry:
  %v1 = and i32 %x, 255
  %v2 = add nuw i32 %v1, 1
  ret i32 %v2
}
`,

  tgt: `define i32 @f(i32 noundef %x) {
entry:
  %v1 = and i32 %x, 255
  %v2 = add i32 %v1, 1
  ret i32 %v2
}
`,

  async prove(session) {
    await session.begin("g1", "src");

    const edit = await session.edit({
      op: "replace",
      v: "%2",
      insts: ["%v2 = add i32 %1, 1"],
    });
    expect("strip nuw flag from addition", edit.kind === "applied", edit);

    const committed = await session.commit({
      window: { from: "%2", to: "%2" },
      preconditions: { "%1": { noundef: true, range: { min: 0, max: 256 } } },
    });
    expect("commit with conditioned window", committed.kind === "certified", committed);
    const step = committed.kind === "certified" ? committed.effects[0] : undefined;
    expect(
      "the certificate records the preconditions",
      step?.effect === "step" && step.window?.preconditions !== undefined,
      committed,
    );
  },
};
