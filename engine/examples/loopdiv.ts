// `reassociate` as a loop body: two divisions, and a running total the tgt
// reassociates around them.
//
// Detached at its header, the callee is one iteration, and it holds the pair
// alive2 cannot take whole. The proof is `reassociate`'s, inside a body of
// several blocks: cut after each division, so that what reaches the solver
// is a call both sides make the same way, and prove each cut's interface
// defined before asking behind it. The loop adds one thing: the values an
// iteration hands the next are defined too, which strengthening proves on
// entry and before the call standing for the rest of the loop, once the
// src's `nsw` flags, which could make the total poison, are gone.
import type { EditOp } from "../core/drivers/llops.ts";
import { expect, type Scenario } from "../core/scenario.ts";

export const loopdiv: Scenario = {
  name: "loopdiv",
  about: "two divisions in a loop body, kept out of every query by cuts inside one iteration",
  verdict: "verified",

  src: `define i64 @f(i64 noundef %n, i64 noundef %a) {
entry:
  br label %head

head:
  %i = phi i64 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i64 [ 0, %entry ], [ %v10, %body ]
  %go = icmp ult i64 %i, %n
  br i1 %go, label %body, label %exit

body:
  %v0 = mul i64 %i, 4
  %v1 = sub i64 %a, %v0
  %v2 = sdiv i64 %v1, 2
  %v3 = mul nsw i64 %v2, 2
  %v4 = add nsw i64 %v0, %v3
  %v5 = mul nsw i64 %s, 2
  %v6 = add nsw i64 %v4, %v5
  %v7 = sub nsw i64 %a, %v6
  %v8 = sdiv i64 %v7, 2
  %v9 = mul nsw i64 %v8, 2
  %v10 = add nsw i64 %v6, %v9
  %i.next = add i64 %i, 1
  br label %head

exit:
  ret i64 %s
}
`,

  tgt: `define i64 @f(i64 noundef %n, i64 noundef %a) {
entry:
  br label %head

head:
  %i = phi i64 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i64 [ 0, %entry ], [ %v10, %body ]
  %go = icmp ult i64 %i, %n
  br i1 %go, label %body, label %exit

body:
  %v0 = shl i64 %i, 2
  %v1 = sub i64 %a, %v0
  %v2 = sdiv i64 %v1, 2
  %sum = add i64 %v2, %s
  %twice = shl i64 %sum, 1
  %q = add i64 %v0, %twice
  %v7 = sub i64 %a, %q
  %v8 = sdiv i64 %v7, 2
  %k = add i64 %v8, %sum
  %twice.k = shl i64 %k, 1
  %v10 = add i64 %twice.k, %v0
  %i.next = add i64 %i, 1
  br label %head

exit:
  ret i64 %s
}
`,

  async prove(session) {
    // i (`%2`), s (`%3`), n (`%0`) and a (`%1`) cross.
    const loop = await session.split("g1", "%bb1", "%bb1", {
      "%2": "%2",
      "%3": "%3",
      "%0": "%0",
      "%1": "%1",
    });
    expect("detach the header", loop.kind === "split", loop);
    if (loop.kind !== "split") return;
    const iteration = loop.children.callee;

    // The callee takes i, s, n and a as `%0` to `%3`. Its src drops every
    // `nsw`, which the tgt has none of, and says `4*i` the tgt's way; the
    // multiply `%5` goes last, since a named value moves the slots after it.
    await session.begin(iteration, "src");
    const wrapping: EditOp[] = [
      ...["%8", "%9", "%10", "%11", "%12", "%14", "%15"].map(
        (v): EditOp => ({ op: "flags", v, flags: { nsw: false } }),
      ),
      { op: "replace", v: "%5", insts: ["%v0 = shl i64 %0, 2"] },
    ];
    for (const op of wrapping) {
      const edited = await session.edit(op);
      expect(`the src takes ${op.op}`, edited.kind === "applied", edited);
    }
    const wrapped = await session.commit();
    expect("take the flags off the src", wrapped.kind === "certified", wrapped);

    // Every value an iteration takes is defined, on entry and each time
    // around.
    const defined = await session.strengthen("g1", {
      param_attrs: {
        0: { noundef: true },
        1: { noundef: true },
        2: { noundef: true },
        3: { noundef: true },
      },
    });
    expect("prove the loop's values defined", defined.kind === "strengthened", defined);

    // Cut after the first division, `%7`: `%8` opens the suffix on both sides,
    // and the parameters, the shift `%5` and the division cross.
    const head = await session.split(iteration, "%8", "%8", {
      "%0": "%0",
      "%1": "%1",
      "%2": "%2",
      "%3": "%3",
      "%5": "%5",
      "%7": "%7",
    });
    expect("cut after the first division", head.kind === "split", head);
    if (head.kind !== "split") return;
    const first = await session.strengthen(iteration, {
      param_attrs: {
        0: { noundef: true },
        1: { noundef: true },
        2: { noundef: true },
        3: { noundef: true },
        4: { noundef: true },
        5: { noundef: true },
      },
    });
    expect("prove the first cut's interface defined", first.kind === "strengthened", first);
    const shared = await session.check(head.children.outer);
    expect("the prefixes are the same", shared.outcome === "proved", shared);

    // In the suffix, the tgt's result `%13` is `v0 + 2*(k + sum)`; say it
    // `q + 2*k` around the division `%10`, with `q` at `%8`, and the doubling
    // `%12` dies.
    const suffix = head.children.callee;
    await session.begin(suffix, "tgt");
    const around = await session.edit({
      op: "replace",
      v: "%13",
      insts: ["%twice.k = shl i64 %10, 1", "%result = add i64 %8, %twice.k"],
    });
    expect("take the tail back around the division", around.kind === "applied", around);
    const dead = await session.edit({ op: "erase", v: "%12", cascade: true });
    expect("erase what the tail no longer uses", dead.kind === "applied", dead);
    const tail = await session.commit();
    expect("commit the tail", tail.kind === "certified", tail);

    // Cut at the second division's subtraction, src `%10` and tgt `%9`: i
    // (`%2`), n (`%4`) and a (`%5`) cross, and the total, src `%9` and tgt `%8`.
    const middle = await session.split(suffix, "%10", "%9", {
      "%2": "%2",
      "%4": "%4",
      "%5": "%5",
      "%9": "%8",
    });
    expect("cut at the second division", middle.kind === "split", middle);
    if (middle.kind !== "split") return;
    const second = await session.strengthen(suffix, {
      param_attrs: {
        0: { noundef: true },
        1: { noundef: true },
        2: { noundef: true },
        3: { noundef: true },
      },
    });
    expect("prove the second cut's interface defined", second.kind === "strengthened", second);

    const totals = await session.check(middle.children.outer);
    expect("the totals, computed two ways", totals.outcome === "proved", totals);
    const division = await session.check(middle.children.callee);
    expect("the division and the rest of the loop", division.outcome === "proved", division);
    const outer = await session.check(loop.children.outer);
    expect("the loop is entered the same way", outer.outcome === "proved", outer);
  },
};
