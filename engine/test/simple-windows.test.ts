// Tests stepping regions as windowed commits: first with a stand-in checker
// that proves windows only, then with alive-tv on the small pairs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certify } from "../cert/main.ts";
import { repoRoot } from "../core/config.ts";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { type Checker, timeoutsFrom } from "../core/state/steps.ts";
import { stepCalls } from "../simple/calls.ts";
import { DEFAULT_LIMITS } from "../simple/limits.ts";
import { regions } from "../simple/regions.ts";
import { bodies, stepWindows } from "../simple/windows.ts";
import { PAPER, pairs } from "./simple-pairs.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
/** The search's limits, with the window growth a test asks for. */
const grow = (growth: number) => ({ ...DEFAULT_LIMITS, growth });
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

const noRun: Interpreter = {
  run() {
    throw new Error("this session has no interpreter");
  },
};
const unrewriting = {} as Llrwt;

/** A stand-in that proves a window when `proves` says so, and settles no whole function. */
function windowsOnly(proves: (src: string) => boolean): Checker & { windows: string[] } {
  const windows: string[] = [];
  return {
    windows,
    async check(src): Promise<CheckResult> {
      const window = src.includes("@outlined_window");
      if (window) windows.push(src);
      const outcome = window && proves(src) ? "correct" : "unknown";
      return {
        outcome,
        detail: "",
        invocation: { binary: "stub", flags: [], timeoutMs: 0 },
        stdout: "",
        ms: 0,
      };
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-windows-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function start(name: string, checker: Checker, checkDefaultMs = 30_000, pair = pairs[name]) {
  if (!pair) throw new Error(`no pair ${name}`);
  return Session.start({
    dir: join(dir, name),
    src: pair.src,
    tgt: pair.tgt,
    llops,
    checker,
    interp: noRun,
    rewriter: unrewriting,
    timeouts: timeoutsFrom({ checkDefaultMs }),
  });
}

/** How many regions the goal's two sides still differ in. */
async function regionsLeft(session: Session) {
  return regions(...(await bodies(session, llops, "g1"))).length;
}

/** Whether the goal's src has become its tgt. */
async function arrived(session: Session) {
  const view = await session.show("g1");
  return view.src.text === view.tgt.text;
}

describe.skipIf(!built)("windows", () => {
  test("a tail step preserves the source call's attributes", async () => {
    const src = `declare void @h(i32)

define void @f(i32 %x) {
entry:
  call void @h(i32 %x)
  ret void
}
`;
    const tgt = src.replace("call void @h(i32 %x)", "tail call void @h(i32 noundef %x)");
    const checker = windowsOnly(() => true);
    const session = await start("tail-attributes", checker, 5_000, {
      about: "",
      refines: false,
      src,
      tgt,
    });
    expect(await stepCalls(session, "g1", ...(await bodies(session, llops, "g1")))).toBe(1);
    const current = (await session.show("g1")).src.text;
    expect(current).toContain("tail call void @h(i32 %0)");
    expect(current).not.toContain("noundef");
  });

  test("a tail step excludes pointers carried directly or inside an aggregate", async () => {
    for (const [k, type] of ["ptr", "<2 x ptr>", "%nested"].entries()) {
      const src = `%nested = type { i32, [2 x ptr] }
declare void @h(${type})

define void @f(${type} %p) {
entry:
  call void @h(${type} %p)
  ret void
}
`;
      const tgt = src.replace("call void", "tail call void");
      const checker = windowsOnly(() => true);
      const session = await start(`tail-pointer-${k}`, checker, 5_000, {
        about: "",
        refines: false,
        src,
        tgt,
      });
      expect(await stepCalls(session, "g1", ...(await bodies(session, llops, "g1")))).toBe(0);
      expect(checker.windows).toEqual([]);
    }
  });

  test("calls stay as they are when the target's markers disagree", async () => {
    const src = `declare void @h(i32)

define void @f(i32 %x) {
entry:
  call void @h(i32 %x)
  call void @h(i32 7)
  ret void
}
`;
    const tgt = src.replace("call void @h(i32 %x)", "tail call void @h(i32 %x)");
    const checker = windowsOnly(() => true);
    const session = await start("mixed-tails", checker, 5_000, {
      about: "",
      refines: true,
      src,
      tgt,
    });
    expect(await stepCalls(session, "g1", ...(await bodies(session, llops, "g1")))).toBe(0);
    expect(checker.windows).toEqual([]);
  });

  test("a tail marker changes only after the window is certified", async () => {
    const src =
      "declare void @h()\n\ndefine void @f() {\nentry:\n  call void @h()\n  ret void\n}\n";
    const tgt = src.replace("call void", "tail call void");
    const checker = windowsOnly(() => false);
    const session = await start("uncertified-tail", checker, 5_000, {
      about: "",
      refines: true,
      src,
      tgt,
    });
    expect(await stepCalls(session, "g1", ...(await bodies(session, llops, "g1")))).toBe(0);
    expect(checker.windows).toHaveLength(1);
    expect((await session.show("g1")).src.text).not.toContain("tail call");
  });

  test("one commit per region: a rewritten instruction, a rewritten pair, a commuted mul", async () => {
    const checker = windowsOnly(() => true);
    const session = await start("e2", checker);
    expect(await stepWindows(session, llops, "g1", grow(0))).toEqual([]);
    expect(checker.windows).toHaveLength(3);
    expect(await arrived(session)).toBe(true);
  });

  test("a refused window grows over the definitions of what it reads", async () => {
    // Only a window that holds the sexts can show the mul does not overflow.
    const checker = windowsOnly((src) => src.includes("sext"));
    const session = await start("varA", checker);
    expect(await stepWindows(session, llops, "g1", grow(1))).toEqual([]);
    expect(checker.windows.map((window) => window.includes("sext"))).toEqual([false, true]);
    expect(await arrived(session)).toBe(true);
  });

  test("a deleted or an inserted instruction is stepped with its neighbour", async () => {
    const src = `define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  %d = add i32 %a, 7
  %b = mul i32 %a, 3
  ret i32 %b
}
`;
    const tgt = src.replace("  %d = add i32 %a, 7\n", "");
    for (const [name, pair] of [
      ["deleted", { src, tgt }],
      ["inserted", { src: tgt, tgt: src }],
    ] as const) {
      const session = await start(
        name,
        windowsOnly(() => true),
        30_000,
        { about: name, refines: true, ...pair },
      );
      expect([name, await stepWindows(session, llops, "g1", grow(0))]).toEqual([name, []]);
      expect(await arrived(session)).toBe(true);
    }
  });

  test("a window that cannot grow far enough leaves its region", async () => {
    const checker = windowsOnly((src) => src.includes("sext"));
    const session = await start("varA", checker);
    expect(await stepWindows(session, llops, "g1", grow(0))).toHaveLength(1);
    expect(await arrived(session)).toBe(false);
  });
});

describe.skipIf(!solving)("windows with alive-tv", () => {
  test("tail markers let reshaped match calls across a loop rotation", async () => {
    const src = `declare void @h(i32)

define i32 @f(i32 %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %next, %body ]
  call void @h(i32 %i)
  %more = icmp ult i32 %i, %n
  br i1 %more, label %body, label %exit

body:
  %next = add i32 %i, 1
  br label %head

exit:
  ret i32 %i
}
`;
    const tgt = `declare void @h(i32)

define i32 @f(i32 %n) {
entry:
  tail call void @h(i32 0)
  %start = icmp ult i32 0, %n
  br i1 %start, label %body, label %exit

body:
  %i = phi i32 [ 0, %entry ], [ %next, %body ]
  %next = add i32 %i, 1
  tail call void @h(i32 %next)
  %more = icmp ult i32 %next, %n
  br i1 %more, label %body, label %exit

exit:
  %r = phi i32 [ 0, %entry ], [ %next, %body ]
  ret i32 %r
}
`;
    const session = await start("rotated-calls", aliveTv, 5_000, {
      about: "",
      refines: true,
      src,
      tgt,
    });
    await stepWindows(session, llops, "g1", grow(0));
    const checked = await session.check("g1");
    expect(checked.outcome).toBe("proved");
    expect(checked.by).toBe("reshaped");
    const certificate = certify(session.dir, join(session.dir, "certificate"));
    const replay = Bun.spawnSync([
      "python3",
      join(repoRoot(), "kernel/check.py"),
      certificate,
      "--llops",
      toolchain.path("llops"),
      "--alive-tv",
      toolchain.path("alive-tv"),
    ]);
    expect(replay.stdout.toString()).toContain("VERIFIED - root g1");
    expect(replay.exitCode).toBe(0);
  }, 60_000);

  test("tail markers step inside a loop beside a changed branch", async () => {
    const src = `declare void @h(i32)

define i32 @f(i32 %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %next, %loop ]
  %next = add i32 %i, 1
  %again = icmp ult i32 %next, %n
  call void @h(i32 %i)
  call void @h(i32 %next)
  br i1 %again, label %loop, label %exit

exit:
  ret i32 %next
}
`;
    const tgt = src
      .replaceAll("call void", "tail call void")
      .replace("br i1 %again, label %loop, label %exit", "br i1 %again, label %exit, label %loop");
    // The branch change remains open; each call can still take its own certified step.
    const session = await start("tail", aliveTv, 5_000, { about: "", refines: false, src, tgt });
    const left = await stepWindows(session, llops, "g1", grow(0));
    expect((await session.show("g1")).src.text.match(/tail call void @h/g)).toHaveLength(2);
    expect(left.some((region) => !region.window)).toBe(true);
  }, 60_000);

  test.each(["e1", "e1alt", "e2", "e3", "varB"])(
    "%s arrives at its tgt",
    async (name) => {
      const session = await start(name, aliveTv, 5_000);
      expect(await stepWindows(session, llops, "g1", grow(1))).toEqual([]);
      expect(await arrived(session)).toBe(true);
    },
    120_000,
  );

  test("a region whose tgt reads another value steps once its window defines it", async () => {
    const src = `define i32 @f(i32 %a, i32 %b) {
entry:
  %c = add i32 %a, 1
  %d = add i32 %a, 2
  %r = xor i32 %c, %d
  ret i32 %r
}
`;
    const tgt = src.replace("%d = add i32 %a, 2", "%d = add i32 %c, 1");
    const pair = { about: "", refines: true, src, tgt };
    const session = await start("reads", aliveTv, 5_000, pair);
    expect(await stepWindows(session, llops, "g1", grow(1))).toEqual([]);
    expect(await arrived(session)).toBe(true);
  }, 60_000);

  test("a region reading another copy of a value steps by their relation", async () => {
    // Both copies are defined in the block before, so the window cannot grow
    // over them; ScalarEvolution sees both as x + 1, which relates the two reads.
    const src = `define i32 @f(i32 noundef %x) {
entry:
  %a = add i32 %x, 1
  %b = sub i32 %x, -1
  br label %next

next:
  %r = mul i32 %a, 3
  ret i32 %r
}
`;
    const tgt = src.replace("mul i32 %a, 3", "mul i32 %b, 3");
    const pair = { about: "", refines: true, src, tgt };
    const session = await start("copies", aliveTv, 5_000, pair);
    expect(await stepWindows(session, llops, "g1", grow(1))).toEqual([]);
    expect(await arrived(session)).toBe(true);
  }, 60_000);

  test("a region whose tgt also hands a value to its own later code steps", async () => {
    // The paper's straight-line pair. The tgt's middle region computes %q, the
    // partner of the src's %t, and %s, which only the tgt's last region reads,
    // so that last region alone is left.
    const session = await start("paper", aliveTv, 5_000, PAPER);
    expect(await regionsLeft(session)).toBe(3);
    expect(await stepWindows(session, llops, "g1", grow(1))).toHaveLength(1);
  }, 120_000);

  // e4 is not a refinement. varA's window is out of alive2's reach even with the
  // sexts in it, and no fact helps, since its operands are poison whenever an
  // input is.
  test.each(["e4", "varA"])(
    "%s keeps its region",
    async (name) => {
      const session = await start(name, aliveTv, 5_000);
      expect(await stepWindows(session, llops, "g1", grow(1))).toHaveLength(1);
    },
    120_000,
  );
});
