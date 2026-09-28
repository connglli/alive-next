// A loop whose step changes two values the rest of the body reads.
//
// Both loops keep a 64-bit total as two 32-bit halves and add 3 each time
// around. The src finds the carry after the add, from the low half wrapping
// below 3; the tgt finds it before, from the low half being above -4. The
// step that reorders the two is one window handing back both the new low
// half, which the header reads, and the carry, which the high half reads.
import { expect, type Scenario } from "../core/scenario.ts";

export const carry: Scenario = {
  name: "carry",
  about: "a loop proved by one step whose window hands back two values",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %lo = phi i32 [ 0, %entry ], [ %lo.next, %body ]
  %hi = phi i32 [ 0, %entry ], [ %hi.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %lo.next = add i32 %lo, 3
  %wrap = icmp ult i32 %lo.next, 3
  %carry = zext i1 %wrap to i32
  %hi.next = add i32 %hi, %carry
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %hi
}
`,

  tgt: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %lo = phi i32 [ 0, %entry ], [ %lo.next, %body ]
  %hi = phi i32 [ 0, %entry ], [ %hi.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %wrap = icmp ugt i32 %lo, -4
  %lo.next = add i32 %lo, 3
  %carry = zext i1 %wrap to i32
  %hi.next = add i32 %hi, %carry
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %hi
}
`,

  async prove(session) {
    // `%6` tests the new low half `%5`; test the old one `%2` instead, first.
    await session.begin("g1", "src");
    const early = await session.edit({
      op: "replace",
      v: "%6",
      insts: ["%w = icmp ugt i32 %2, -4"],
    });
    expect("test the low half before the add", early.kind === "applied", early);
    const moved = await session.edit({ op: "move", v: "%w", where: "before", w: "%5" });
    expect("move the test before the add", moved.kind === "applied", moved);
    const found = await session.commit();
    expect("find the carry the tgt's way", found.kind === "certified", found);
  },
};
