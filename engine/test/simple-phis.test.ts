// Tests exposing narrow loop state through certified target steps.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certify } from "../cert/main.ts";
import { repoRoot } from "../core/config.ts";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
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

describe.skipIf(!built)("loop state at different widths", () => {
  test("the search proves a widened loop and its certificate replays", async () => {
    const session = await start(pair(8, 16));
    const limits = { ...DEFAULT_LIMITS, stages: false, rules: false, counterexampleMs: 0 };
    expect(await search(session, llops, limits)).toBe("verified");
    session.finish();
    const pkg = certify(dir, join(dir, "certificate"));
    const replay = spawnSync(
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
    expect(replay.status, replay.stdout + replay.stderr).toBe(0);
    expect(replay.stdout).toContain("VERIFIED");
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
