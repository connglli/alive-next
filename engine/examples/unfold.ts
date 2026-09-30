// A loop the tgt unrolls by two, proved by unfolding the src.
//
// s sums the numbers below n = 2 * m. The tgt runs two iterations each time
// around and tests i < n only before the first, which is right because i and
// n are both even. Detached at its header, the src's callee runs one
// iteration before it calls its hypothesis, and the tgt's runs two. Unfolding
// the src makes it run two as well, so both call the hypothesis with the same
// state. The invariant that i and n are even makes the src's second test
// always pass. It holds only every second iteration, so it is stated after
// the unfold.
import { expect, type Scenario } from "../core/scenario.ts";

export const unfold: Scenario = {
  name: "unfold",
  about: "a loop the tgt unrolls by two, proved by unfolding the src",
  verdict: "verified",

  src: `define i32 @f(i32 noundef %m) {
entry:
  %n = shl i32 %m, 1
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %i
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`,

  tgt: `define i32 @f(i32 noundef %m) {
entry:
  %n = shl i32 %m, 1
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next2, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next2, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %i
  %i.next = add nuw i32 %i, 1
  %s.next2 = add i32 %s.next, %i.next
  %i.next2 = add nuw i32 %i, 2
  br label %head

exit:
  ret i32 %s
}
`,

  async prove(session) {
    // `%bb1` is the header. Its phis `%2` (i) and `%3` (s) and the bound `%1`
    // (n) cross, in that order.
    const split = await session.split("g1", "%bb1", "%bb1", { "%2": "%2", "%3": "%3", "%1": "%1" });
    expect(
      "detach the header",
      split.kind === "split" && split.detach?.hypothesis !== undefined,
      split,
    );
    if (split.kind !== "split") return;

    const unfolded = await session.unfold("g3", "src");
    expect("run two iterations of the src per call", unfolded.kind === "certified", unfolded);

    // i | n is even: parameter 0 is i, and parameter 2 is n.
    const kept = await session.strengthen("g1", {
      predicates: [
        {
          insts: [
            "%both = or i32 !0, !2",
            "%low = and i32 %both, 1",
            "%even = icmp eq i32 %low, 0",
          ],
        },
      ],
    });
    expect(
      "the invariant holds on entry and every two iterations keep it",
      kept.kind === "strengthened",
      kept,
    );
  },
};
