// A loop proved by one step inside it, with no detach.
//
// Both loops sum a bitfield of `a ^ i`; the src masks the field before it
// shifts and the tgt after, as `vectorize`'s src and tgt do. The step that
// says the src the tgt's way is asked about the two instructions it touches,
// which do not loop even though the body around them does, and after it the
// two sides are one program, which proves the goal.
import type { EditOp } from "../core/drivers/llops.ts";
import { expect, type Scenario } from "../core/scenario.ts";

export const loopstep: Scenario = {
  name: "loopstep",
  about: "a loop proved by one step inside its body, with no detach",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n, i32 noundef %a) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %x = xor i32 %a, %i
  %m = and i32 %x, 4190208
  %f = ashr i32 %m, 12
  %s.next = add i32 %s, %f
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 noundef %n, i32 noundef %a) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %x = xor i32 %a, %i
  %m = lshr i32 %x, 12
  %f = and i32 %m, 1023
  %s.next = add i32 %s, %f
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // `%6` masks `%5`, `a ^ i`; once it is a shift, the `ashr` after it is `%6`.
    await session.begin("g1", "src");
    const masking: EditOp[] = [
      { op: "replace", v: "%6", insts: ["%s = lshr i32 %5, 12"] },
      { op: "replace", v: "%6", insts: ["%t = and i32 %s, 1023"] },
    ];
    for (const op of masking) {
      const edited = await session.edit(op);
      expect("the src moves its mask", edited.kind === "applied", edited);
    }
    const masked = await session.commit();
    expect("mask the field the tgt's way, inside the loop", masked.kind === "certified", masked);
  },
};
