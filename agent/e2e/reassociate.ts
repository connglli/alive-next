// The whole method on one program, and the first pair alive2 cannot take
// whole: given two minutes on the two functions below it answers nothing.
//
// Both programs round a value down to a multiple of two twice, once around
// `4*p0` and once around the running total, and the tgt reassociates the
// second rounding and drops the overflow flags. Everything but the two
// divisions is arithmetic modulo 2^64, so the identity itself is easy; the
// divisions are what the solver cannot see through. A query that has to prove
// two differently spelled totals equal underneath a 64 bit `sdiv` is a query
// that does not come back.
//
// So the proof never writes that query. Each cut leaves a division inside a
// function both sides call the same way, and an unknown call is an
// uninterpreted function: equal arguments give equal results, with no
// reasoning about division at all. What reaches the solver is four small
// queries, under a second together.
//
// The store holds canonical text, so a script names values by slot, and slots
// move as a body is edited. The comments track what each slot is where it is
// named.
import { expect, type Scenario } from "./scenario.ts";

export const reassociate: Scenario = {
  name: "reassociate",
  about: "two cuts keep an sdiv out of every query alive2 is asked",

  src: `define i64 @f(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = mul nsw i64 %p0, 4
  %v1 = sub nsw i64 %p1, %v0
  %v2 = sdiv i64 %v1, 2
  %v3 = mul nsw i64 %v2, 2
  %v4 = add nsw i64 %v0, %v3
  %v5 = mul nsw i64 %p2, 2
  %v6 = add nsw i64 %v4, %v5
  %v7 = sub nsw i64 %p1, %v6
  %v8 = sdiv i64 %v7, 2
  %v9 = mul nsw i64 %v8, 2
  %v10 = add nsw i64 %v6, %v9
  ret i64 %v10
}
`,

  tgt: `define i64 @f(i64 %p0, i64 %p1, i64 %p2) {
entry:
  %v0 = shl nsw i64 %p0, 2
  %v1 = sub nsw i64 %p1, %v0
  %v2 = sdiv i64 %v1, 2
  %sum = add i64 %v2, %p2
  %twice = shl i64 %sum, 1
  %q = add i64 %v0, %twice
  %v7 = sub i64 %p1, %q
  %v8 = sdiv i64 %v7, 2
  %k = add i64 %v8, %sum
  %twice.k = shl i64 %k, 1
  %v10 = add i64 %twice.k, %v0
  ret i64 %v10
}
`,

  async prove(session) {
    // The heads differ only in how `4*p0` is spelled, so say it the tgt's way.
    // `%3` is the multiply and `%0` the first parameter.
    await session.begin("g1", "src");
    const shifted = await session.edit({
      op: "replace",
      v: "%3",
      insts: ["%v0 = shl nsw i64 %0, 2"],
    });
    expect("write the multiply as a shift", shifted.kind === "applied", shifted);
    const aligned = await session.commit();
    expect("commit the shift", aligned.kind === "certified", aligned);

    // The first three instructions are shared now, so cut after the first
    // division: `%6` opens the suffix on both sides, and four values cross,
    // the parameters `%1` and `%2`, the shift `%3` and the division `%5`.
    const head = await session.split("g1", "%6", "%6", {
      "%1": "%1",
      "%2": "%2",
      "%3": "%3",
      "%5": "%5",
    });
    expect("cut after the first division", head.kind === "split", head);
    if (head.kind !== "split") return;

    // Two identical programs around the same call.
    const shared = await session.check(head.children.outer);
    expect(`check ${head.children.outer}`, shared.outcome === "proved", shared);

    // The tgt's tail is `v0 + 2*(k + sum)`, which is `q + 2*k` because `q` is
    // `v0 + 2*sum`. Saying it the second way is a step on the tgt side, and it
    // is cheap because the division stays where it is, feeding both spellings:
    // `%8` is the division, `%6` the total, `%11` the result and `%10` the
    // doubling that dies with it.
    const callee = head.children.callee;
    await session.begin(callee, "tgt");
    const around = await session.edit({
      op: "replace",
      v: "%11",
      insts: ["%twice.k = shl i64 %8, 1", "%result = add i64 %6, %twice.k"],
    });
    expect("take the tail back around the division", around.kind === "applied", around);
    const dead = await session.edit({ op: "erase", v: "%10", cascade: true });
    expect("erase what the tail no longer uses", dead.kind === "applied", dead);
    const tail = await session.commit();
    expect("commit the tail", tail.kind === "certified", tail);

    // Both tails need only the total and `p1` now, so the second division and
    // everything after it is cut off into a function the two sides call the
    // same way. The src subtracts at `%8` and the tgt at `%7`, and the totals
    // they consume are `%7` and `%6`.
    const middle = await session.split(callee, "%8", "%7", { "%2": "%2", "%7": "%6" });
    expect("cut at the second division", middle.kind === "split", middle);
    if (middle.kind !== "split") return;

    // The total, computed two ways, in front of the same unknown call. This is
    // the query the whole proof was arranged to make askable.
    const totals = await session.check(middle.children.outer);
    expect(`check ${middle.children.outer}`, totals.outcome === "proved", totals);

    // And what that call stands for, where the sides differ only in the flags
    // the src carries and in one doubling written as a shift.
    const division = await session.check(middle.children.callee);
    expect(`check ${middle.children.callee}`, division.outcome === "proved", division);
  },
};
