// A loop refuted by running it.
//
// Both sides accumulate a sum the loop carries, and the target returns the
// value of one iteration too late. alive-tv answers a loop only for the
// iterations it unrolls, so a check of the pair is a search whose refutation
// is a hint; the run ends on an input both programs run on under llubi.
import { expect, type Scenario } from "../core/scenario.ts";

export const unroll: Scenario = {
  name: "unroll",
  about: "a loop refuted by running it",
  verdict: "counterexample",

  src: `define i32 @f(i32 noundef %n) {
entry:
  br label %loop
loop:
  %i = phi i32 [0, %entry], [%i.next, %loop]
  %acc = phi i32 [0, %entry], [%acc.next, %loop]
  %i.next = add i32 %i, 1
  %acc.next = add i32 %acc, %i
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit
exit:
  ret i32 %acc
}
`,

  tgt: `define i32 @f(i32 noundef %n) {
entry:
  br label %loop
loop:
  %i = phi i32 [0, %entry], [%i.next, %loop]
  %acc = phi i32 [0, %entry], [%acc.next, %loop]
  %i.next = add i32 %i, 1
  %acc.next = add i32 %acc, %i
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit
exit:
  ret i32 %acc.next
}
`,

  async prove(session) {
    // Unrolled twice the two part company, and the root stays open.
    const checked = await session.check("g1", undefined, 2);
    expect("the search refutes the pair", checked.outcome === "refuted", checked);
    expect("a search does not end the run", session.verdict === "unknown", checked);

    // For n = 2 the src returns the accumulated 0 and the tgt the 1 it added
    // after, which the replay under llubi shows.
    const reported = await session.reportCex([{ kind: "int", value: "2" }]);
    expect("the two programs diverge on 2", reported.kind === "refuted", reported);
  },
};
