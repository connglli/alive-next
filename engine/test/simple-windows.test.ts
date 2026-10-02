// Tests stepping regions as windowed commits: first with a stand-in checker
// that proves windows only, then with alive-tv on the small pairs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { type Checker, timeoutsFrom } from "../core/state/steps.ts";
import { stepWindows } from "../simple/windows.ts";
import { pairs } from "./simple-pairs.ts";
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

async function start(name: string, checker: Checker, alive2Ms = 30_000) {
  const pair = pairs[name];
  if (!pair) throw new Error(`no pair ${name}`);
  return Session.start({
    dir: join(dir, name),
    src: pair.src,
    tgt: pair.tgt,
    llops,
    checker,
    interp: noRun,
    rewriter: unrewriting,
    timeouts: timeoutsFrom({ alive2Ms }),
  });
}

/** Whether the goal's src has become its tgt. */
async function arrived(session: Session) {
  const view = await session.show("g1");
  return view.src.text === view.tgt.text;
}

describe.skipIf(!built)("windows", () => {
  test("one commit per region: a rewritten instruction, a rewritten pair, a commuted mul", async () => {
    const checker = windowsOnly(() => true);
    const session = await start("e2", checker);
    expect(await stepWindows(session, llops, "g1", 0)).toEqual([]);
    expect(checker.windows).toHaveLength(3);
    expect(await arrived(session)).toBe(true);
  });

  test("a refused window grows over the definitions of what it reads", async () => {
    // Only a window that holds the sexts can show the mul does not overflow.
    const checker = windowsOnly((src) => src.includes("sext"));
    const session = await start("varA", checker);
    expect(await stepWindows(session, llops, "g1", 1)).toEqual([]);
    expect(checker.windows.map((window) => window.includes("sext"))).toEqual([false, true]);
    expect(await arrived(session)).toBe(true);
  });

  test("a window that cannot grow far enough leaves its region", async () => {
    const checker = windowsOnly((src) => src.includes("sext"));
    const session = await start("varA", checker);
    expect(await stepWindows(session, llops, "g1", 0)).toHaveLength(1);
    expect(await arrived(session)).toBe(false);
  });
});

describe.skipIf(!solving)("windows with alive-tv", () => {
  test.each(["e1", "e1alt", "e2", "e3", "varB"])(
    "%s arrives at its tgt",
    async (name) => {
      const session = await start(name, aliveTv, 5_000);
      expect(await stepWindows(session, llops, "g1", 1)).toEqual([]);
      expect(await arrived(session)).toBe(true);
    },
    120_000,
  );

  // e4 is not a refinement. varA's window is out of alive2's reach even with the
  // sexts in it, and no fact helps, since its operands are poison whenever an
  // input is.
  test.each(["e4", "varA"])(
    "%s keeps its region",
    async (name) => {
      const session = await start(name, aliveTv, 5_000);
      expect(await stepWindows(session, llops, "g1", 1)).toHaveLength(1);
    },
    120_000,
  );
});
