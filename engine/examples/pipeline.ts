// A proof that needs every mechanism, because the whole pair is one alive2
// cannot take: two `sdiv`s sit in the body, and the solver does not come back
// when it has to prove two differently spelled totals equal underneath them.
// Each cut leaves a `sdiv` inside a function both sides call the same way, so
// what reaches the solver is a call, not a division. Before the cuts, the
// verified rewriter rewrites a `mul … 4` to a `shl … 2`, and a transaction
// strips an `nsw` flag the tgt has no counterpart for and the callee cannot
// promise.
//
// The program is `reassociate` with one addition the src makes and the tgt
// does not: `mul … 4` written as `shl … 2` by the rewriter. The `nsw` on the
// first doubling is what makes the second cut's interface impossible until it
// is gone, since a value an `nsw` doubling could poison is not one the caller
// can promise defined.
import { expect, type Scenario } from "../core/scenario.ts";

export const pipeline: Scenario = {
  name: "pipeline",
  about: "a rewrite, a flag strip, two cuts, and two strengthenings",

  src: `define i64 @f(i64 noundef %p0, i64 noundef %p1, i64 noundef %p2) {
entry:
  %v0 = mul i64 %p0, 4
  %v1 = sub i64 %p1, %v0
  %v2 = sdiv i64 %v1, 2
  %v3 = mul nsw i64 %v2, 2
  %v4 = add i64 %v0, %v3
  %v5 = mul i64 %p2, 2
  %v6 = add i64 %v4, %v5
  %v7 = sub i64 %p1, %v6
  %v8 = sdiv i64 %v7, 2
  %v9 = mul nsw i64 %v8, 2
  %v10 = add i64 %v6, %v9
  ret i64 %v10
}
`,

  tgt: `define i64 @f(i64 noundef %p0, i64 noundef %p1, i64 noundef %p2) {
entry:
  %v0 = shl i64 %p0, 2
  %v1 = sub i64 %p1, %v0
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
    // Phase 1: the src writes `mul i64 %p0, 4` where the tgt writes
    // `shl i64 %p0, 2`. The verified rewriter has a rule for that, and its
    // proof certifies the move with no solver run.
    const rewritten = await session.rewrite("g1", "src", ["muli-pow2-to-shl"]);
    expect("rewrite the multiply as a shift", rewritten.kind === "certified", rewritten);

    // Phase 2: the first doubling (`%6 = shl nsw i64 %5, 1`) carries `nsw`.
    // The callee behind the second cut would have to promise that value
    // defined, but an `nsw` shift can make poison, so the caller cannot.
    // Dropping the flag is a forward refinement, so it is a step on the src
    // side.
    await session.begin("g1", "src");
    const stripped = await session.edit({
      op: "replace",
      v: "%6",
      insts: ["%clean = shl i64 %5, 1"],
    });
    expect("strip the nsw flag", stripped.kind === "applied", stripped);
    const committed = await session.commit();
    expect("commit the flag strip", committed.kind === "certified", committed);

    // Phase 3: the first three instructions are shared now, so cut after the
    // first division: `%6` opens the suffix on both sides, and four values
    // cross — the parameters `%1` and `%2`, the shift `%3`, and the division
    // `%5`.
    const first = await session.split("g1", "%6", "%6", {
      "%1": "%1",
      "%2": "%2",
      "%3": "%3",
      "%5": "%5",
    });
    expect("cut after the first division", first.kind === "split", first);
    if (first.kind !== "split") return;

    // Phase 4: the four values crossing the cut are computed from defined
    // parameters by instructions that cannot make poison (now that the `nsw`
    // is gone), so the callee can be told so.
    const firstStronger = await session.strengthen("g1", {
      param_attrs: {
        0: { noundef: true },
        1: { noundef: true },
        2: { noundef: true },
        3: { noundef: true },
      },
    });
    expect(
      "prove the first cut's interface defined",
      firstStronger.kind === "strengthened",
      firstStronger,
    );

    // The outer is two identical programs around the same call.
    const firstOuter = await session.check(first.children.outer);
    expect(`check ${first.children.outer}`, firstOuter.outcome === "proved", firstOuter);

    // Phase 5: the tgt's tail is `v0 + 2*(k + sum)`, which is `q + 2*k`
    // because `q` is `v0 + 2*sum`. Saying it the second way is a step on the
    // tgt side, and it is cheap because the division stays where it is.
    const callee = first.children.callee;
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

    // The `nsw` on the second division's doubling (`%v9 = mul nsw i64 %v8, 2`)
    // could make the total poison, which is a promise the caller cannot keep.
    // The flags say nothing the tgt relies on, so the src says the whole body
    // the wrapping way, in one step.
    await session.begin(callee, "src");
    const wrapping = await session.edit({
      op: "set_body",
      body: `  %4 = mul i64 %1, 2
  %5 = add i64 %0, %4
  %6 = mul i64 %3, 2
  %7 = add i64 %5, %6
  %8 = sub i64 %2, %7
  %9 = sdiv i64 %8, 2
  %10 = mul i64 %9, 2
  %11 = add i64 %7, %10
  ret i64 %11`,
    });
    expect("take the flags off the src", wrapping.kind === "applied", wrapping);
    const wrapped = await session.commit();
    expect("commit the wrapping form", wrapped.kind === "certified", wrapped);

    // Phase 6: both tails need only the total and `p1` now, so the second
    // division and everything after it is cut off. The src subtracts at `%8`
    // and the tgt at `%7`, and the totals they consume are `%7` and `%6`.
    const second = await session.split(callee, "%8", "%7", { "%2": "%2", "%7": "%6" });
    expect("cut at the second division", second.kind === "split", second);
    if (second.kind !== "split") return;

    // Again the interface is defined once nothing before it can make poison.
    const secondStronger = await session.strengthen(callee, {
      param_attrs: { 0: { noundef: true }, 1: { noundef: true } },
    });
    expect(
      "prove the second cut's interface defined",
      secondStronger.kind === "strengthened",
      secondStronger,
    );

    // The total, computed two ways, in front of the same unknown call. This is
    // the query the whole proof was arranged to make askable.
    const secondOuter = await session.check(second.children.outer);
    expect(`check ${second.children.outer}`, secondOuter.outcome === "proved", secondOuter);

    // And what that call stands for, where the sides differ only in the flags
    // the src carries and in one doubling written as a shift.
    const secondCallee = await session.check(second.children.callee);
    expect(`check ${second.children.callee}`, secondCallee.outcome === "proved", secondCallee);
  },
};
