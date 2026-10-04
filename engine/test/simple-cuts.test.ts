// Tests cutting goals: peeling a region that no window can hold into a goal of
// its own, cutting where a goal's expensive operations split evenly, and
// strengthening a cut with what the analyses know or a loop's invariants.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { timeoutsFrom } from "../core/state/steps.ts";
import { countdown } from "../examples/countdown.ts";
import { loop } from "../examples/loop.ts";
import { rotated } from "../examples/rotated.ts";
import { strchr } from "../examples/strchr.ts";
import { cut, cutBalanced, cutLoop } from "../simple/cuts.ts";
import { strengthenCut } from "../simple/facts.ts";
import { strengthenLoop } from "../simple/invariants.ts";
import { DEFAULT_LIMITS } from "../simple/limits.ts";
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

  test("a balanced cut splits the multiplies evenly", async () => {
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
    const halves = await cutBalanced(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut");
    const muls = async (gid: string) =>
      (await bodies(session, llops, gid))[0].filter((i) => i.opcode === "mul").length;
    expect([await muls(halves.outer), await muls(halves.callee)]).toEqual([2, 2]);
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
    interp: {} as Interpreter,
    rewriter: {} as Llrwt,
    timeouts: timeoutsFrom({ alive2Ms: 5_000 }),
  });
}

/** The status of each of `goals`. */
function statuses(session: Session, goals: string[]) {
  return goals.map((gid) => session.tree.goals.get(gid)?.status);
}

describe.skipIf(!solving)("cuts with alive-tv", () => {
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
    await session.unsplit("g1");
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
    await session.unsplit("g1");
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
    await strengthenLoop(session, "g1", facts, []);
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

  test("a rotated loop is cut at its exit, then at its header", async () => {
    const session = await solved("rotated", rotated.src, rotated.tgt);
    const exit = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!exit) throw new Error("expected a cut at the exit");
    const header = await cutLoop(session, llops, exit.outer, DEFAULT_LIMITS);
    if (!header) throw new Error("expected a cut at the header");
    expect((await session.check(header.callee)).outcome).toBe("proved");
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
