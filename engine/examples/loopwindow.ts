// A loop whose step holds only given an instruction it does not touch.
//
// Both loops add the low byte of `i`, plus one, to a sum; the src passes it
// through an `i9` and back, which the tgt drops. That is right only because
// the byte is at most 255, which the `and` before the step says. The window
// the step touches leaves the `and` out, so the step names a wider one that
// takes it in, rather than a precondition, which would be proved on the whole
// body, and the body loops.
import { expect, type Scenario } from "../core/scenario.ts";

export const loopwindow: Scenario = {
  name: "loopwindow",
  about: "a loop proved by one step whose window takes in the fact it needs",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %x = and i32 %i, 255
  %w = add i32 %x, 1
  %t = trunc i32 %w to i9
  %e = zext i9 %t to i32
  %s.next = add i32 %s, %e
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %x = and i32 %i, 255
  %e = add i32 %x, 1
  %s.next = add i32 %s, %e
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // `%4` is the byte, and `%5` to `%7` its round trip through `i9`.
    await session.begin("g1", "src");
    const direct = await session.edit({ op: "replace", v: "%7", insts: ["%e = add i32 %4, 1"] });
    expect("add one to the byte directly", direct.kind === "applied", direct);
    const dead = await session.edit({ op: "erase", v: "%6", cascade: true });
    expect("erase the round trip", dead.kind === "applied", dead);
    const widened = await session.commit({ window: { from: "%4", to: "%7" } });
    expect("prove it with the byte in the window", widened.kind === "certified", widened);
  },
};
