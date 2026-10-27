// Tests cutting goals: peeling a region that no window can hold into a goal of
// its own, cutting where a goal's expensive operations divide evenly, and
// strengthening a cut with what the analyses know or a loop's invariants.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import { Llubi } from "../core/drivers/llubi.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { timeoutsFrom } from "../core/state/steps.ts";
import { countdown } from "../examples/countdown.ts";
import { loop } from "../examples/loop.ts";
import { rotated } from "../examples/rotated.ts";
import { scenario } from "../examples/scenarios.ts";
import { slots } from "../examples/slots.ts";
import { strchr } from "../examples/strchr.ts";
import { unfold } from "../examples/unfold.ts";
import {
  balancedPoints,
  beforePoints,
  cut,
  cutAt,
  cutLoop,
  joinFirst,
  returnFacts,
} from "../simple/cuts.ts";
import { strengthenCut } from "../simple/facts.ts";
import { fill } from "../simple/fill.ts";
import { DEFAULT_LIMITS } from "../simple/limits.ts";
import { strengthenLoop } from "../simple/loops.ts";
import { peel } from "../simple/peel.ts";
import { regions } from "../simple/regions.ts";
import { bodies } from "../simple/windows.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);
const aliveTv = new AliveTv(toolchain.path("alive-tv"));
const solving =
  built &&
  (await aliveTv
    .version()
    .then(() => true)
    .catch(() => false));
// A loop cut runs the goal under llubi before it asks alive2 about its candidates.
const llubi = new Llubi(toolchain.path("llubi"));
const running = await llubi
  .version()
  .then((line) => line.length > 0)
  .catch(() => false);

/** A branch and a select whose products feed calls in unmatched blocks. */
const PRODUCT = {
  src: `define void @f(i1 %c, i32 %x, i32 %y, i32 %z) {
entry:
  br i1 %c, label %other, label %join

other:
  br label %join

join:
  %p = phi i32 [ %x, %entry ], [ %y, %other ]
  %m = mul i32 %p, %z
  %r = call i32 @h(i32 %m)
  br label %done

done:
  call void @g(i32 %r, i32 %p)
  ret void
}

declare i32 @h(i32)
declare void @g(i32, i32)
`,
  tgt: `define void @f(i1 %c, i32 %x, i32 %y, i32 %z) {
entry:
  %p = select i1 %c, i32 %y, i32 %x
  %m = mul i32 %p, %z
  %r = call i32 @h(i32 %m)
  br label %done

done:
  call void @g(i32 %r, i32 %p)
  ret void
}

declare i32 @h(i32)
declare void @g(i32, i32)
`,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-peel-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function start(src: string, tgt: string) {
  const unknown: CheckResult = {
    outcome: "unknown",
    detail: "",
    invocation: { binary: "stub", flags: [], timeoutMs: 0 },
    stdout: "",
    ms: 0,
  };
  return Session.start({
    dir: join(dir, "run"),
    src,
    tgt,
    llops,
    checker: { check: async () => unknown },
    interp: {} as Interpreter,
    rewriter: {} as Llrwt,
  });
}

/** How many regions are left in each goal. */
async function left(session: Session, goals: string[]) {
  return Promise.all(
    goals.map(async (gid) => regions(...(await bodies(session, llops, gid))).length),
  );
}

describe.skipIf(!built)("peel", () => {
  test("a region that ends the body is cut at its head", async () => {
    const src = `define i32 @f(i32 %x, i32 %y) {
entry:
  %a = mul i32 %x, %y
  %b = add i32 %a, 1
  %c = sub i32 %b, %x
  ret i32 %c
}
`;
    const session = await start(
      src,
      src.replace("  %c = sub i32 %b, %x\n  ret i32 %c", "  ret i32 0"),
    );
    const [region] = regions(...(await bodies(session, llops, "g1")));
    if (!region) throw new Error("expected a region");
    expect(region.window).toBe(false);
    const peeled = await peel(session, llops, "g1", DEFAULT_LIMITS, region);
    expect(await left(session, peeled.goals)).toEqual([0, 1]);
    expect(peeled.goals.indexOf(peeled.region)).toBe(1);
  });

  test("a region that starts the goal's own code is not cut at its head", async () => {
    const src = `define i32 @f(i32 %x, i32 %y) {
entry:
  %le = icmp ule i32 %x, %y
  call void @llvm.assume(i1 %le)
  %a = add i32 %x, 1
  %b = mul i32 %a, %y
  ret i32 %b
}

declare void @llvm.assume(i1 noundef)
`;
    const session = await start(src, src.replace("add i32 %x, 1", "add i32 %x, 2"));
    const [region] = regions(...(await bodies(session, llops, "g1")));
    if (!region) throw new Error("expected a region");
    const peeled = await peel(session, llops, "g1", DEFAULT_LIMITS, region);
    expect(peeled.goals).toHaveLength(2);
    expect(peeled.goals[0]).toBe(peeled.region);
  });

  test("a phi with code after it is cut after it, then at its block", async () => {
    const src = `define i32 @f(i1 %c, i32 %x) {
entry:
  br i1 %c, label %t, label %e

t:
  %a = add i32 %x, 1
  br label %j

e:
  %b = sub i32 %x, 1
  br label %j

j:
  %p = phi i32 [ %a, %t ], [ %b, %e ]
  %r = mul i32 %p, 3
  ret i32 %r
}
`;
    const session = await start(src, src.replace("[ %b, %e ]", "[ %x, %e ]"));
    const [region] = regions(...(await bodies(session, llops, "g1")));
    if (!region) throw new Error("expected a region");
    const peeled = await peel(session, llops, "g1", DEFAULT_LIMITS, region);
    // Detaching the phi's block turns the phi into the callee's parameter, so
    // the difference moves to the value the outer passes it.
    expect(await left(session, peeled.goals)).toEqual([1, 0, 0]);
  });

  test("a phi with another phi after it is cut at its block alone", async () => {
    const src = `define i32 @f(i1 %c, i32 %x) {
entry:
  br i1 %c, label %t, label %e

t:
  %a = add i32 %x, 1
  br label %j

e:
  %b = sub i32 %x, 1
  br label %j

j:
  %p = phi i32 [ %a, %t ], [ %b, %e ]
  %q = phi i32 [ %x, %t ], [ 0, %e ]
  %s = add i32 %p, %q
  %r = mul i32 %s, 3
  ret i32 %r
}
`;
    const session = await start(src, src.replace("[ %b, %e ]", "[ %x, %e ]"));
    const [region] = regions(...(await bodies(session, llops, "g1")));
    if (!region) throw new Error("expected a region");
    const peeled = await peel(session, llops, "g1", DEFAULT_LIMITS, region);
    expect(peeled.goals).toHaveLength(2);
  });

  test("a cut goes before a floating-point add both sides apply", async () => {
    const src = `define float @f(float %x, float %y, float %z) {
entry:
  %a = fadd float %x, %y
  %b = fadd float %a, %z
  ret float %b
}
`;
    const session = await start(src, src.replace("fadd float %a", "fadd nnan float %a"));
    expect(beforePoints(...(await bodies(session, llops, "g1")))).toEqual([["#1", "#1"]]);
  });

  test("no cut goes before an operation only the goal's assumptions precede", async () => {
    const src = `define i32 @f(i32 %x, i32 %y) {
entry:
  %le = icmp ule i32 %x, %y
  call void @llvm.assume(i1 %le)
  %a = mul i32 %x, %y
  %b = mul i32 %a, %x
  ret i32 %b
}

declare void @llvm.assume(i1 noundef)
`;
    const session = await start(src, src.replace("mul i32 %a", "mul nsw i32 %a"));
    expect(beforePoints(...(await bodies(session, llops, "g1")))).toEqual([["#3", "#3"]]);
  });

  test("unmatched operations with different operands do not become cut points", async () => {
    const tgt = PRODUCT.tgt.replace("mul i32 %p, %z", "mul i32 %y, %z");
    const session = await start(PRODUCT.src, tgt);
    expect(beforePoints(...(await bodies(session, llops, "g1")))).toEqual([]);
  });

  test("unmatched operations with several possible partners do not become cut points", async () => {
    const tgt = PRODUCT.tgt.replace(
      "%r = call i32 @h(i32 %m)",
      "%n = mul i32 %p, %z\n  %r = call i32 @h(i32 %n)",
    );
    const session = await start(PRODUCT.src, tgt);
    expect(beforePoints(...(await bodies(session, llops, "g1")))).toEqual([]);
  });

  test("a cut that outside code joins below it is made at the join first", async () => {
    // A cut before the second multiply reaches the return, which the early exit enters too.
    const src = `define i32 @f(i1 %c, i32 %x, i32 %y) {
entry:
  br i1 %c, label %early, label %work

work:
  %a = mul i32 %x, %y
  %b = mul i32 %a, %x
  br label %early

early:
  %r = phi i32 [ 0, %entry ], [ %b, %work ]
  ret i32 %r
}
`;
    const session = await start(src, src.replace("mul i32 %a", "mul nsw i32 %a"));
    const [mine, theirs] = await bodies(session, llops, "g1");
    const [point] = beforePoints(mine, theirs);
    if (!point) throw new Error("expected a point before the multiply");
    const join = (body: typeof mine) => body.find((i) => i.phi)?.block ?? "";
    expect(joinFirst(mine, theirs, point)).toEqual([join(mine), join(theirs)] as const);
    const halves = await cutAt(session, llops, "g1", DEFAULT_LIMITS, point);
    if (!halves) throw new Error("expected a cut at the join");
    // Each exit of the outer calls the join now, so the point itself can be cut.
    const [outer, its] = await bodies(session, llops, halves.outer);
    const [again] = beforePoints(outer, its);
    if (!again) throw new Error("expected a point before the multiply in the outer");
    expect(joinFirst(outer, its, again)).toEqual(again);
  });

  test("a balanced cut counts what its point reaches", async () => {
    const src = `define i32 @f(i1 %c, i32 %x, i32 %y) {
entry:
  %a = mul i32 %x, %y
  %b = mul i32 %a, %x
  br i1 %c, label %more, label %done

done:
  ret i32 %b

more:
  %d = mul i32 %b, %y
  %e = mul nuw i32 %d, %x
  ret i32 %e
}
`;
    const session = await start(src, src.replace("mul nuw", "mul"));
    // The exit's return sits halfway down the list, but a cut there moves no multiply.
    const points = balancedPoints(...(await bodies(session, llops, "g1")));
    expect(points.map(([at]) => at)).not.toContain("#3");
    expect(points.length).toBeGreaterThan(0);
  });

  test("a balanced cut divides the multiplies evenly", async () => {
    const src = `define i32 @f(i32 %x, i32 %y) {
entry:
  %a = mul i32 %x, %y
  %b = mul i32 %a, %x
  %c = mul i32 %b, %y
  %d = mul i32 %c, %x
  %r = add i32 %d, 1
  ret i32 %r
}
`;
    const session = await start(src, src.replace("add i32 %d, 1", "add i32 %d, 2"));
    const [at] = balancedPoints(...(await bodies(session, llops, "g1")));
    const halves = at && (await cut(session, llops, "g1", DEFAULT_LIMITS, ...at));
    if (!halves) throw new Error("expected a cut");
    const muls = async (gid: string) =>
      (await bodies(session, llops, gid))[0].filter((i) => i.opcode === "mul").length;
    expect([await muls(halves.outer), await muls(halves.callee)]).toEqual([2, 2]);
  });
});

describe.skipIf(!built)("return facts", () => {
  test("are read off the function's return, those that make a value outside it poison", async () => {
    const ranged = "define noundef range(i32 -1, -2147483648) i32 @f(i32 %x) {\n  ret i32 %x\n}\n";
    expect(await returnFacts(llops, ranged)).toEqual({ range: { min: -1, max: -2147483648 } });
    const pointer = "define nonnull align 8 ptr @f(ptr %p) {\n  ret ptr %p\n}\n";
    expect(await returnFacts(llops, pointer)).toEqual({ nonnull: true, align: 8 });
    const plain = ranged.replace("noundef range(i32 -1, -2147483648) ", "");
    expect(await returnFacts(llops, plain)).toEqual({});
  });
});

/** A session whose checks alive-tv answers. */
function solved(name: string, src: string, tgt: string) {
  return Session.start({
    dir: join(dir, name),
    src,
    tgt,
    llops,
    checker: aliveTv,
    interp: llubi,
    rewriter: {} as Llrwt,
    timeouts: timeoutsFrom({ checkDefaultMs: 5_000 }),
  });
}

/** The status of each of `goals`. */
function statuses(session: Session, goals: string[]) {
  return goals.map((gid) => session.tree.goals.get(gid)?.status);
}

describe.skipIf(!solving || !running)("cuts with alive-tv", () => {
  test("filling rebuilds a value when its matched instruction has another type", async () => {
    const src = `define void @f(i32 %x, i64 %wide) {
entry:
  %next = add i32 %x, 1
  %stop = icmp eq i32 %next, 0
  br i1 %stop, label %exit, label %pass

pass:
  br label %call

call:
  call void @g(i32 %next, i64 poison)
  br label %exit

exit:
  ret void
}
declare void @g(i32, i64)
`;
    const tgt = `define void @f(i32 %x, i64 %wide) {
entry:
  %next = add i64 %wide, 1
  %stop = icmp eq i64 %next, 0
  br i1 %stop, label %exit, label %narrow

narrow:
  %low = trunc i64 %next to i32
  br label %call

call:
  call void @g(i32 %low, i64 %next)
  br label %exit

exit:
  ret void
}
declare void @g(i32, i64)
`;
    const session = await solved("fill-types", src, tgt);
    expect(await fill(session, llops, "g1", "g", ["i32", "i64"])).toBe(true);
    const filled = (await session.show("g1")).src.text;
    expect(filled).not.toContain("i64 poison");
    expect(filled).toContain("add i64");
  });

  test("cuts before a product in unmatched blocks using its paired operands", async () => {
    const session = await solved("operands", PRODUCT.src, PRODUCT.tgt);
    const [src, tgt] = await bodies(session, llops, "g1");
    const points = beforePoints(src, tgt);
    const product = (body: typeof src) => `#${body.findIndex((i) => i.opcode === "mul")}`;
    expect(points).toEqual([[product(src), product(tgt)]]);
    const point = points[0];
    if (!point) throw new Error("expected a cut before the product");
    const halves = await cutAt(session, llops, "g1", { ...DEFAULT_LIMITS, facts: false }, point);
    if (!halves) throw new Error("expected a cut");
    for (const gid of [halves.outer, halves.callee])
      expect((await session.check(gid)).outcome).toBe("proved");
    expect(session.verdict).toBe("verified");
  });

  test("a cut passes what the analyses know to its callee", async () => {
    // The tgt's callee adds nuw nsw to the value it is passed, which is safe
    // only in the range that the outer's mask leaves.
    const src = `define i32 @f(i32 noundef %x) {
entry:
  %a = and i32 %x, 255
  %b = add i32 %a, 1
  ret i32 %b
}
`;
    const session = await solved("facts", src, src.replace("add i32", "add nuw nsw i32"));
    const bare = await cut(session, llops, "g1", { ...DEFAULT_LIMITS, facts: false }, "#1", "#1");
    if (!bare) throw new Error("expected a cut");
    expect((await session.check(bare.callee)).outcome).toBe("refuted");
    await session.uncut("g1");
    const halves = await cut(session, llops, "g1", DEFAULT_LIMITS, "#1", "#1");
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.outer, halves.callee])).toEqual(["proved", "proved"]);
  }, 60_000);

  test("a cut keeps noundef when a pointer fact beside it does not prove", async () => {
    // The tgt drops a freeze of the pointer the callee is passed, which needs
    // noundef, and nothing shows that 1024 bytes can be read through it.
    const src = `define ptr @f(ptr noundef %p) {
entry:
  %q = getelementptr i8, ptr %p, i64 1
  %f = freeze ptr %q
  ret ptr %f
}
`;
    const tgt = src.replace("  %f = freeze ptr %q\n  ret ptr %f", "  ret ptr %q");
    const session = await solved("noundef", src, tgt);
    const halves = await cut(session, llops, "g1", { ...DEFAULT_LIMITS, facts: false }, "#1", "#1");
    if (!halves) throw new Error("expected a cut");
    const candidates = { param_attrs: { 0: { noundef: true, dereferenceable: 1024 } } };
    await strengthenCut(session, "g1", candidates);
    expect(statuses(session, [halves.callee])).toEqual(["proved"]);
  }, 60_000);

  test("a loop cut keeps the invariants that each iteration keeps", async () => {
    // The tgt marks i - j nuw, which one iteration shows only knowing j <= i.
    const session = await solved("loop", loop.src, loop.tgt);
    const bare = await cutLoop(session, llops, "g1", { ...DEFAULT_LIMITS, facts: false });
    if (!bare) throw new Error("expected a cut");
    expect((await session.check(bare.callee)).outcome).toBe("refuted");
    await session.uncut("g1");
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.callee])).toEqual(["proved"]);
  }, 120_000);

  test("a cut passes the bits the analyses know to its callee", async () => {
    // The paper's straight-line callee: the tgt drops the and that clears the
    // lowest bit, which is right only because t is even.
    const src = `define i64 @f(i64 noundef %x, i64 noundef %p1) {
entry:
  %t = shl i64 %x, 1
  %v7 = sub i64 %p1, %t
  %v8 = sdiv i64 %v7, 2
  %v9 = mul i64 %v8, 2
  %r = add i64 %t, %v9
  %h = and i64 %r, -2
  ret i64 %h
}
`;
    const tgt = src.replace(
      "  %v9 = mul i64 %v8, 2\n  %r = add i64 %t, %v9\n  %h = and i64 %r, -2\n  ret i64 %h",
      "  %k2 = shl i64 %v8, 1\n  %r = add i64 %t, %k2\n  ret i64 %r",
    );
    const session = await solved("even", src, tgt);
    const halves = await cut(session, llops, "g1", DEFAULT_LIMITS, "#1", "#1");
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.callee])).toEqual(["proved"]);
  }, 120_000);

  test("a loop cut keeps an analysis fact and an invariant together", async () => {
    // The tgt marks n + i nsw, which needs both i <= n, an invariant, and an
    // upper bound on n from the mask, which only the analyses give.
    const src = `define i32 @f(i32 noundef %x) {
entry:
  %n = and i32 %x, 1023
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %i.next = add i32 %i, 1
  br label %head

exit:
  %d = add i32 %n, %i
  ret i32 %d
}
`;
    const session = await solved("both", src, src.replace("add i32 %n", "add nsw i32 %n"));
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.callee])).toEqual(["proved"]);
  }, 120_000);

  test("a loop cut keeps a pointer fact that each iteration keeps", async () => {
    // The tgt loads from s before the loop's test, which is right only for an
    // s that can be read, as the caller's attributes say.
    const src = `define i32 @f(ptr noundef align 4 dereferenceable(4) %s, i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %acc = phi i32 [ 0, %entry ], [ %acc.next, %body ]
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %v = load i32, ptr %s, align 4
  %acc.next = add i32 %acc, %v
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %acc
}
`;
    const tgt = src
      .replace("  %c = icmp", "  %v = load i32, ptr %s, align 4\n  %c = icmp")
      .replace("body:\n  %v = load i32, ptr %s, align 4\n", "body:\n");
    const session = await solved("pointer", src, tgt);
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.callee])).toEqual(["proved"]);
  }, 120_000);

  test("a loop cut keeps noundef when a pointer fact beside it does not prove", async () => {
    // The tgt drops a freeze of the pointer each iteration is passed, which
    // needs noundef, and nothing shows that 1024 bytes can be read through it.
    const src = `define ptr @f(ptr noundef %s) {
entry:
  br label %head

head:
  %p = phi ptr [ %s, %entry ], [ %p.next, %body ]
  %v = load i8, ptr %p
  %c = icmp eq i8 %v, 0
  br i1 %c, label %exit, label %body

body:
  %p.next = getelementptr i8, ptr %p, i64 1
  br label %head

exit:
  %f = freeze ptr %p
  ret ptr %f
}
`;
    const tgt = src.replace("  %f = freeze ptr %p\n  ret ptr %f", "  ret ptr %p");
    const session = await solved("noundef", src, tgt);
    const halves = await cutLoop(session, llops, "g1", { ...DEFAULT_LIMITS, facts: false });
    if (!halves) throw new Error("expected a cut");
    const facts = { param_attrs: { 0: { noundef: true, dereferenceable: 1024 } } };
    await strengthenLoop(session, "g1", facts);
    expect(statuses(session, [halves.callee])).toEqual(["proved"]);
  }, 120_000);

  test("a cut passes the src's own value where the tgt passes one it lacks", async () => {
    // The tgt counts down to its exit in a value the src does not have.
    const session = await solved("countdown", countdown.src, countdown.tgt);
    const halves = await cutLoop(session, llops, "g1", { ...DEFAULT_LIMITS, facts: false });
    if (!halves) throw new Error("expected a cut");
    for (const gid of [halves.outer, halves.callee])
      expect((await session.show(gid)).src.text).not.toContain("poison");
  }, 120_000);

  test("a loop cut keeps the relation two counters of the loop keep", async () => {
    // The tgt stops when left reaches 0, which is i reaching n only while left is n - i.
    const session = await solved("counters", countdown.src, countdown.tgt);
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.outer, halves.callee])).toEqual(["proved", "proved"]);
  }, 120_000);

  test("a loop cut gives its callee what the tgt says of its return", async () => {
    // The tgt says the count is never negative, which the outer holds only
    // once the loop is shown to return no other.
    const counted = scenario("returnfact");
    const session = await solved("returns", counted.src, counted.tgt);
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.outer, halves.callee])).toEqual(["proved", "proved"]);
  }, 120_000);

  test("a loop the tgt unrolled is cut with the src's iteration unfolded", async () => {
    // The tgt's counter steps by 2 where the src's steps by 1.
    const session = await solved("unrolled", unfold.src, unfold.tgt);
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.callee])).toEqual(["proved"]);
  }, 120_000);

  test("a loop the tgt peeled proves once the src's outer is unfolded", async () => {
    // The tgt runs the first iteration behind a guard that also enters the exit.
    const peeled = scenario("peel");
    const session = await solved("peeled", peeled.src, peeled.tgt);
    const header = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!header) throw new Error("expected a cut at the headers");
    const halves = [header.outer, header.callee];
    for (const gid of halves) expect((await session.check(gid)).outcome).toBe("proved");
  }, 120_000);

  test("a peel is unfolded within the budget, whatever the outers' sizes", async () => {
    // The src builds the start of s in steps the tgt does not take, so its outer is larger.
    const peeled = scenario("peel");
    const steps = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => `  %a${k} = add i32 %a${k - 1}, 0\n`);
    const src = peeled.src
      .replace("entry:\n", `entry:\n  %a0 = add i32 %a, 0\n${steps.join("")}`)
      .replace("[ %a, %entry ]", "[ %a8, %entry ]");
    for (const [unfolds, outcome] of [
      [4, "proved"],
      [0, "refuted"],
    ] as const) {
      const session = await solved(`budget${unfolds}`, src, peeled.tgt);
      const limits = { ...DEFAULT_LIMITS, unfolds };
      const header = await cutLoop(session, llops, "g1", limits);
      if (!header) throw new Error("expected a cut at the headers");
      expect((await session.check(header.outer)).outcome).toBe(outcome);
    }
  }, 240_000);

  test("a cut before a load gives it one address on both sides", async () => {
    // The tgt loads from a + off where the src loads from a + 4 * i.
    const pair = scenario("offset");
    const session = await solved("load", pair.src, pair.tgt);
    const loop = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    const callee = loop?.callee ?? "";
    const [at] = loop ? beforePoints(...(await bodies(session, llops, callee))) : [];
    const halves = at && (await cut(session, llops, callee, DEFAULT_LIMITS, ...at));
    if (!halves) throw new Error("expected a cut before the load");
    for (const gid of [halves.outer, halves.callee])
      expect((await session.check(gid)).outcome).toBe("proved");
  }, 240_000);

  test("a rotated loop's guard gets its own copy of the exit, and the header is cut", async () => {
    const session = await solved("rotated", rotated.src, rotated.tgt);
    const header = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!header) throw new Error("expected a cut at the header");
    expect(session.tree.goals.get(header.callee)?.detach?.hypothesis).toBeDefined();
    expect((await session.check(header.callee)).outcome).toBe("proved");
  }, 120_000);

  test("a rotated loop is cut at its exit, then at its header, with no steps", async () => {
    const session = await solved("rotated", rotated.src, rotated.tgt);
    const cutting = { ...DEFAULT_LIMITS, steps: false };
    const exit = await cutLoop(session, llops, "g1", cutting);
    if (!exit) throw new Error("expected a cut at the exit");
    const header = await cutLoop(session, llops, exit.outer, cutting);
    if (!header) throw new Error("expected a cut at the header");
    expect((await session.check(header.callee)).outcome).toBe("proved");
  }, 120_000);

  test("a loop that keeps its state in stack slots is cut by what they hold", async () => {
    // The tgt is the src after mem2reg. The counter and the sum pair with its phis
    // through loads that read them, and the slot stored before it is read with poison.
    const session = await solved("slots", slots.src, slots.tgt);
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.outer, halves.callee])).toEqual(["proved", "proved"]);
  }, 120_000);

  test("a loop cut keeps a comparison with zero that each iteration keeps", async () => {
    // The tgt tests for the key before the end, which is right only for a key
    // that is not zero, as the guard before the loop makes sure.
    const session = await solved("strchr", strchr.src, strchr.tgt);
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut");
    expect(statuses(session, [halves.outer, halves.callee])).toEqual(["proved", "proved"]);
  }, 120_000);
});
