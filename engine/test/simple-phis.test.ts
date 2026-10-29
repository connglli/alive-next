// Tests aligning loop state through certified casts on either side.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certify } from "../cert/main.ts";
import { repoRoot } from "../core/config.ts";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { type EditOp, Llops } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import { Llubi } from "../core/drivers/llubi.ts";
import { Session } from "../core/session.ts";
import { type Checker, timeoutsFrom } from "../core/state/steps.ts";
import { cutLoop } from "../simple/cuts.ts";
import { DEFAULT_LIMITS } from "../simple/limits.ts";
import { search } from "../simple/search.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const aliveTv = new AliveTv(toolchain.path("alive-tv"));
const llubi = new Llubi(toolchain.path("llubi"));
const built = await Promise.all([llops.version(), aliveTv.version(), llubi.version()])
  .then(() => true)
  .catch(() => false);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-phis-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A widened counter, optionally beside a second counter that wraps at the narrow width. */
function pair(narrow: number, wide: number, signed = false, twice = false) {
  const [n, w] = [`i${narrow}`, `i${wide}`];
  const flag = signed ? "nsw" : "nuw";
  const cmp = signed ? "slt" : "ult";
  const ext = signed ? "sext" : "zext";
  return {
    src: `define ${n} @f(${n} noundef %n) {
entry:
  br label %head

head:
  %i = phi ${n} [ 0, %entry ], [ %next, %body ]
${twice ? `  %j = phi ${n} [ 0, %entry ], [ %j.next, %body ]\n` : ""}  %cond = icmp ${cmp} ${n} %i, %n
  br i1 %cond, label %body, label %exit

body:
  call void @tick(${n} %i${twice ? `, ${n} %j` : ""})
  %next = add ${flag} ${n} %i, 1
${twice ? `  %j.next = add ${n} %j, 2\n` : ""}  br label %head

exit:
  ret ${n} %${twice ? "j" : "i"}
}
declare void @tick(${n}${twice ? `, ${n}` : ""})
`,
    tgt: `define ${n} @f(${n} noundef %n) {
entry:
  %bound = ${ext} ${n} %n to ${w}
  br label %head

head:
  %i = phi ${w} [ 0, %entry ], [ %next, %body ]
${twice ? `  %j = phi ${w} [ 0, %entry ], [ %j.next, %body ]\n` : ""}  %cond = icmp ${cmp} ${w} %i, %bound
  br i1 %cond, label %body, label %exit

body:
  %a = trunc ${w} %i to ${n}
${twice ? `  %b = trunc ${w} %j to ${n}\n` : ""}  call void @tick(${n} %a${twice ? `, ${n} %b` : ""})
  %next = add ${flag} ${w} %i, 1
${twice ? `  %j.next = add ${w} %j, 2\n` : ""}  br label %head

exit:
  %result = trunc ${w} %${twice ? "j" : "i"} to ${n}
  ret ${n} %result
}
declare void @tick(${n}${twice ? `, ${n}` : ""})
`,
  };
}

/** State stored after extension and read only through truncation, with an independent counter. */
function narrowed(wide: number, narrow: number, signed = false, twice = false) {
  const [w, n] = [`i${wide}`, `i${narrow}`];
  const ext = signed ? "sext" : "zext";
  const flag = signed ? "nsw" : "nuw";
  const initial = signed ? BigInt.asIntN(narrow, 1n) : 1n;
  const module = (source: boolean) => `define ${n} @f(i32 noundef %n) {
entry:
  br label %head

head:
  %state = phi ${source ? w : n} [ 0, %entry ], [ %state.next, %body ]
${twice ? `  %other = phi ${source ? w : n} [ ${source ? initial : 1}, %entry ], [ %other.next, %body ]\n` : ""}  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %more = icmp ult i32 %i, %n
${source ? `  %value = trunc ${flag} ${w} %state to ${n}\n` : ""}${source && twice ? `  %other.value = trunc ${flag} ${w} %other to ${n}\n` : ""}  br i1 %more, label %body, label %exit

body:
  call void @tick(${n} %${source ? "value" : "state"}${twice ? `, ${n} %${source ? "other.value" : "other"}` : ""})
  %${source ? "next" : "state.next"} = call ${n} @next()
${source ? `  %state.next = ${ext} ${n} %next to ${w}\n` : ""}${twice ? `  %${source ? "other.low" : "other.next"} = call ${n} @another()\n` : ""}${source && twice ? `  %other.next = ${ext} ${n} %other.low to ${w}\n` : ""}  %i.next = add nuw i32 %i, 1
  br label %head

exit:
  ret ${n} %${source ? "value" : "state"}
}
declare void @tick(${n}${twice ? `, ${n}` : ""})
declare ${n} @next()
${twice ? `declare ${n} @another()\n` : ""}`;
  return { src: module(true), tgt: module(false) };
}

/** A session on `programs`, using the supplied checker and toolbox. */
function start(programs: ReturnType<typeof pair>, checker: Checker = aliveTv, toolbox = llops) {
  return Session.start({
    dir,
    ...programs,
    llops: toolbox,
    checker,
    interp: llubi,
    rewriter: {} as Llrwt,
    timeouts: timeoutsFrom({ checkDefaultMs: 5_000 }),
  });
}

/** Replays the certificate without the searcher. */
function replay(session: Session) {
  session.finish();
  const pkg = certify(session.dir, join(session.dir, "certificate"));
  const checked = spawnSync(
    "python3",
    [
      join(repoRoot(), "kernel/check.py"),
      pkg,
      "--llops",
      toolchain.path("llops"),
      "--alive-tv",
      toolchain.path("alive-tv"),
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect(checked.status, checked.stdout + checked.stderr).toBe(0);
  expect(checked.stdout).toContain("VERIFIED");
}

/** A narrow counter whose extension, rather than the counter, matches the target phi. */
function extended(narrow: number, wide: number, signed: boolean, separate: boolean) {
  const [n, w] = [`i${narrow}`, `i${wide}`];
  const ext = signed ? "sext" : "zext";
  const cmp = signed ? "slt" : "ult";
  const flag = signed ? "nsw" : "nuw";
  const first = signed ? -2 : 0;
  const module = (source: boolean) => {
    const type = source ? n : w;
    return `define void @f() {
entry:
  br label %head

head:
  %i = phi ${type} [ ${first}, %entry ], [ %next, %${separate ? "body" : "head"} ]
${separate ? `  %more = icmp ${source ? cmp : "ne"} ${type} %i, 8\n  br i1 %more, label %body, label %exit\n\nbody:\n` : ""}${source ? `  %value = ${ext} ${n} %i to ${w}\n` : ""}  call void @tick(${w} %${source ? "value" : "i"})
  %next = add ${flag} ${type} %i, 1
${separate ? "  br label %head" : `  %more = icmp ${source ? cmp : "ne"} ${type} %${source ? "i" : "next"}, ${source ? 7 : 8}\n  br i1 %more, label %head, label %exit`}

exit:
  ret void
}
declare void @tick(${w})
`;
  };
  return { src: module(true), tgt: module(false) };
}

describe.skipIf(!built)("loop state at different widths", () => {
  for (const [narrow, wide, signed, separate] of [
    [8, 16, false, false],
    [16, 32, true, false],
    [32, 64, false, true],
    [8, 16, true, true],
  ] as const)
    test(`matches a source ${signed ? "sext" : "zext"} from i${narrow} to i${wide} in the ${separate ? "body" : "header"}`, async () => {
      const session = await start(extended(narrow, wide, signed, separate));
      const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
      if (!halves) throw new Error("expected a cut through the source extension");
      for (const gid of [halves.outer, halves.callee])
        expect((await session.check(gid)).outcome).toBe("proved");
      expect(session.verdict).toBe("verified");
      replay(session);
    }, 120_000);

  test("matching an extension does not prove different signed values equal", async () => {
    const programs = extended(8, 16, true, true);
    programs.src = programs.src.replace("sext i8", "zext i8");
    const session = await start(programs);
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut through the source extension");
    const outcomes = [];
    for (const gid of [halves.outer, halves.callee])
      outcomes.push((await session.check(gid)).outcome);
    expect(outcomes).toContain("refuted");
    expect(session.verdict).not.toBe("verified");
  }, 120_000);

  test("aligns source and target views together and replays the certificate", async () => {
    const programs = pair(8, 16);
    programs.src = programs.src
      .replace("head:\n", "head:\n  %state = phi i8 [ 0, %entry ], [ %state.next, %body ]\n")
      .replace("  br i1 %cond", "  %value = trunc nuw i8 %state to i1\n  br i1 %cond")
      .replace(
        "body:\n",
        "body:\n  call void @flag(i1 %value)\n  %coin = call i1 @coin()\n  %state.next = zext i1 %coin to i8\n",
      );
    programs.tgt = programs.tgt
      .replace("head:\n", "head:\n  %state = phi i1 [ false, %entry ], [ %state.next, %body ]\n")
      .replace("body:\n", "body:\n  call void @flag(i1 %state)\n  %state.next = call i1 @coin()\n");
    for (const side of ["src", "tgt"] as const)
      programs[side] += "declare void @flag(i1)\ndeclare i1 @coin()\n";
    const session = await start(programs);
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a cut with both views");
    for (const gid of [halves.outer, halves.callee])
      expect((await session.check(gid)).outcome).toBe("proved");
    expect(session.verdict).toBe("verified");
    replay(session);
  }, 120_000);

  test("preserves poison from the source truncation's flags", async () => {
    const src = `define i1 @f(i1 noundef %again) {
entry:
  br label %head

head:
  %wide = phi i8 [ 2, %entry ], [ 2, %head ]
  %value = trunc nuw i8 %wide to i1
  br i1 %again, label %head, label %exit

exit:
  ret i1 %value
}
`;
    const tgt = src
      .replace(
        "%wide = phi i8 [ 2, %entry ], [ 2, %head ]",
        "%value = phi i1 [ true, %entry ], [ true, %head ]",
      )
      .replace("  %value = trunc nuw i8 %wide to i1\n", "");
    const session = await start({ src, tgt });
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a projected loop cut");
    for (const gid of [halves.outer, halves.callee])
      expect((await session.check(gid)).outcome).toBe("proved");
    expect(session.verdict).toBe("verified");
  }, 60_000);

  for (const [wide, narrow, signed] of [
    [8, 1, false],
    [40, 12, true],
    [17, 9, false],
  ] as const)
    test(`projects i${wide} source state to i${narrow}`, async () => {
      const session = await start(narrowed(wide, narrow, signed));
      const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
      if (!halves) throw new Error("expected a projected loop cut");
      for (const gid of [halves.outer, halves.callee])
        expect((await session.check(gid)).outcome).toBe("proved");
      expect(session.verdict).toBe("verified");
    }, 60_000);

  test("projects two source phis without changing their order", async () => {
    const session = await start(narrowed(17, 9, false, true));
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a projected loop cut");
    for (const gid of [halves.outer, halves.callee])
      expect((await session.check(gid)).outcome).toBe("proved");
    expect(session.verdict).toBe("verified");
  }, 60_000);

  test("reuses projected source state after its cut is undone", async () => {
    const session = await start(narrowed(17, 9, false, true));
    const limits = { ...DEFAULT_LIMITS, facts: false };
    expect(await cutLoop(session, llops, "g1", limits)).toBeDefined();
    expect((await session.uncut("g1")).kind).toBe("uncut");
    const before = (await session.show("g1")).src.hash;
    expect(await cutLoop(session, llops, "g1", limits)).toBeDefined();
    expect((await session.show("g1")).src.hash).toBe(before);
  }, 60_000);

  test("leaves source state with another use unchanged", async () => {
    const programs = narrowed(16, 8);
    programs.src = programs.src
      .replace("define i8 @f", "define i16 @f")
      .replace("ret i8 %value", "ret i16 %state");
    programs.tgt = programs.tgt
      .replace("define i8 @f", "define i16 @f")
      .replace("ret i8 %state", "%wide = zext i8 %state to i16\n  ret i16 %wide");
    const session = await start(programs);
    const before = (await session.show("g1")).src.hash;
    expect(await cutLoop(session, llops, "g1", DEFAULT_LIMITS)).toBeUndefined();
    expect((await session.show("g1")).src.hash).toBe(before);
  });

  test("leaves narrowed source state unchanged when steps are disabled", async () => {
    const session = await start(narrowed(8, 1));
    const before = (await session.show("g1")).src.hash;
    expect(
      await cutLoop(session, llops, "g1", { ...DEFAULT_LIMITS, steps: false }),
    ).toBeUndefined();
    expect((await session.show("g1")).src.hash).toBe(before);
  });

  test("reverts source preparation when the unused phi cannot be erased", async () => {
    class NoErase extends Llops {
      override async edit(module: string, op: EditOp) {
        if (op.op === "erase")
          return { ok: false as const, code: "used", message: "phi cannot be erased" };
        return super.edit(module, op);
      }
    }
    const toolbox = new NoErase(toolchain.path("llops"));
    const session = await start(narrowed(8, 1), aliveTv, toolbox);
    const before = (await session.show("g1")).src.hash;
    expect(await cutLoop(session, toolbox, "g1", DEFAULT_LIMITS)).toBeUndefined();
    expect((await session.show("g1")).src.hash).toBe(before);
    expect((await session.status()).editing).toBeUndefined();
  });

  test("reverts source preparation when hoisting is not certified", async () => {
    class NoShape extends Llops {
      override async reshaped() {
        return { ok: true as const, reshaped: false, why: "not certified" };
      }
    }
    const toolbox = new NoShape(toolchain.path("llops"));
    const session = await start(narrowed(8, 1), aliveTv, toolbox);
    const before = (await session.show("g1")).src.hash;
    expect(await cutLoop(session, toolbox, "g1", DEFAULT_LIMITS)).toBeUndefined();
    expect((await session.show("g1")).src.hash).toBe(before);
    expect((await session.status()).editing).toBeUndefined();
  });

  test("the search proves a widened loop and its certificate replays", async () => {
    const session = await start(pair(8, 16));
    const limits = { ...DEFAULT_LIMITS, stages: false, rules: false, counterexampleMs: 0 };
    expect(await search(session, llops, limits)).toBe("verified");
    replay(session);
  }, 60_000);

  for (const [narrow, wide, signed] of [
    [8, 16, false],
    [12, 40, false],
    [8, 32, true],
  ] as const)
    test(`cuts i${narrow} state against i${wide} state with a ${signed ? "signed" : "unsigned"} bound`, async () => {
      const session = await start(pair(narrow, wide, signed));
      const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
      if (!halves) throw new Error("expected a loop cut");
      for (const gid of [halves.outer, halves.callee])
        expect((await session.check(gid)).outcome).toBe("proved");
      expect(session.verdict).toBe("verified");
    }, 60_000);

  test("keeps both value matches when the second counter wraps", async () => {
    const session = await start(pair(8, 9, false, true));
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a loop cut");
    for (const gid of [halves.outer, halves.callee])
      expect((await session.check(gid)).outcome).toBe("proved");
    expect(session.verdict).toBe("verified");
  }, 60_000);

  test("fills wide state after aligning a peeled target loop", async () => {
    const programs = pair(8, 16);
    programs.tgt = programs.tgt
      .replace(
        "  br label %head\n\nhead:",
        `  %empty = icmp eq i8 %n, 0
  br i1 %empty, label %early, label %first

early:
  ret i8 0

first:
  call void @tick(i8 0)
  br label %head

head:`,
      )
      .replace("phi i16 [ 0, %entry ]", "phi i16 [ 1, %first ]");
    const session = await start(programs);
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a loop cut");
    for (const gid of [halves.outer, halves.callee])
      expect((await session.check(gid)).outcome).toBe("proved");
    expect(session.verdict).toBe("verified");
  }, 60_000);

  test("relates a wrapping counter to an unwrapped counter", async () => {
    const src = `define i8 @f() {
entry:
  br label %head

head:
  %i = phi i8 [ 1, %entry ], [ %next, %body ]
  %more = icmp ne i8 %i, 0
  br i1 %more, label %body, label %exit

body:
  call void @tick(i8 %i)
  %next = add i8 %i, 1
  br label %head

exit:
  ret i8 %i
}
declare void @tick(i8)
`;
    const tgt = `define i8 @f() {
entry:
  br label %head

head:
  %i = phi i9 [ 1, %entry ], [ %next, %body ]
  %more = icmp ne i9 %i, 256
  br i1 %more, label %body, label %exit

body:
  %value = trunc i9 %i to i8
  call void @tick(i8 %value)
  %next = add nuw i9 %i, 1
  br label %head

exit:
  %result = trunc i9 %i to i8
  ret i8 %result
}
declare void @tick(i8)
`;
    const session = await start({ src, tgt });
    const halves = await cutLoop(session, llops, "g1", DEFAULT_LIMITS);
    if (!halves) throw new Error("expected a loop cut");
    for (const gid of [halves.outer, halves.callee])
      expect((await session.check(gid)).outcome).toBe("proved");
    expect(session.verdict).toBe("verified");
  }, 60_000);

  test("reuses a narrow view after its cut is undone", async () => {
    const session = await start(pair(8, 16));
    const limits = { ...DEFAULT_LIMITS, facts: false };
    expect(await cutLoop(session, llops, "g1", limits)).toBeDefined();
    expect((await session.uncut("g1")).kind).toBe("uncut");
    const before = (await session.show("g1")).tgt.hash;
    expect(await cutLoop(session, llops, "g1", limits)).toBeDefined();
    expect((await session.show("g1")).tgt.hash).toBe(before);
  }, 60_000);

  test("leaves the target unchanged when steps are disabled", async () => {
    const session = await start(pair(8, 16));
    const before = (await session.show("g1")).tgt.hash;
    expect(
      await cutLoop(session, llops, "g1", { ...DEFAULT_LIMITS, steps: false }),
    ).toBeUndefined();
    expect((await session.show("g1")).tgt.hash).toBe(before);
  });

  test("keeps no view whose window is not certified", async () => {
    const unknown: CheckResult = {
      outcome: "unknown",
      detail: "",
      invocation: { binary: "stub", flags: [], timeoutMs: 0 },
      stdout: "",
      ms: 0,
    };
    const session = await start(pair(8, 16), { check: async () => unknown });
    const before = (await session.show("g1")).tgt.hash;
    expect(await cutLoop(session, llops, "g1", DEFAULT_LIMITS)).toBeUndefined();
    expect((await session.show("g1")).tgt.hash).toBe(before);
    expect((await session.status()).editing).toBeUndefined();
  });

  test("undoes the inserted view when hoisting is not certified", async () => {
    class NoShape extends Llops {
      override async reshaped() {
        return { ok: true as const, reshaped: false, why: "not certified" };
      }
    }
    const toolbox = new NoShape(toolchain.path("llops"));
    const session = await start(pair(8, 16), aliveTv, toolbox);
    const before = (await session.show("g1")).tgt.hash;
    expect(await cutLoop(session, toolbox, "g1", DEFAULT_LIMITS)).toBeUndefined();
    expect((await session.show("g1")).tgt.hash).toBe(before);
    expect((await session.status()).editing).toBeUndefined();
  });
});
