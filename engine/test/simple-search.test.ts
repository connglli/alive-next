// Tests the simple searcher end to end: first with stand-in checkers, then with
// alive-tv on the small pairs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { type Checker, timeoutsFrom } from "../core/state/steps.ts";
import { DEFAULT_LIMITS } from "../simple/limits.ts";
import { search } from "../simple/search.ts";
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

const limits = { ...DEFAULT_LIMITS, rootMs: 2_000, stages: false };

/** A stand-in that answers `correct` where `proves` says so, and settles nothing else. */
function stub(proves: (src: string, asked: number) => boolean): Checker {
  let asked = 0;
  return {
    async check(src): Promise<CheckResult> {
      const outcome = proves(src, asked++) ? "correct" : "unknown";
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
  dir = mkdtempSync(join(tmpdir(), "alive-next-search-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function start(src: string, tgt: string, checker: Checker) {
  return Session.start({
    dir: join(dir, "run"),
    src,
    tgt,
    llops,
    checker,
    interp: {} as Interpreter,
    rewriter: {} as Llrwt,
    timeouts: timeoutsFrom({ alive2Ms: 5_000, checkDefaultMs: 5_000 }),
  });
}

/** The tools the run called, in order. */
function moves(session: Session): string[] {
  const lines = readFileSync(join(session.dir, "trajectory.jsonl"), "utf8").split("\n");
  return lines.filter(Boolean).flatMap((line) => {
    const entry = JSON.parse(line);
    return entry.kind === "tool_call" ? [entry.tool] : [];
  });
}

describe.skipIf(!built)("search", () => {
  test("proves a pair through its windows", async () => {
    const pair = pairs.e2;
    if (!pair) throw new Error("no pair e2");
    const session = await start(
      pair.src,
      pair.tgt,
      stub((src) => src.includes("@outlined_window")),
    );
    expect(await search(session, llops, limits)).toBe("verified");
  });

  test("peels a region once, and leaves its goal open when nothing closes it", async () => {
    const pair = pairs.varA;
    if (!pair) throw new Error("no pair varA");
    const session = await start(
      pair.src,
      pair.tgt,
      stub(() => false),
    );
    expect(await search(session, llops, limits)).toBe("unknown");
    expect(moves(session).filter((move) => move === "split")).toHaveLength(2);
    expect(moves(session).at(-1)).toBe("give_up");
  });

  test("walks the src through the optimizer's stages", async () => {
    const src = `define i32 @f(i32 noundef %x) {
entry:
  %x.addr = alloca i32, align 4
  store i32 %x, ptr %x.addr, align 4
  %0 = load i32, ptr %x.addr, align 4
  %mul = mul nsw i32 %0, 8
  ret i32 %mul
}
`;
    const stages = await llops.pipelineStages(src);
    if (!stages.ok) throw new Error(stages.message);
    const tgt = stages.stages.at(-1)?.module ?? src;
    // Everything but the first question, the root's, is proved.
    const session = await start(
      src,
      tgt,
      stub((_, asked) => asked > 0),
    );
    expect(await search(session, llops, { ...limits, stages: true })).toBe("verified");
    expect(moves(session).filter((move) => move === "tx_commit").length).toBeGreaterThan(0);
  });
});

describe.skipIf(!solving)("search with alive-tv", () => {
  const run = async (name: string) => {
    const pair = pairs[name];
    if (!pair) throw new Error(`no pair ${name}`);
    return search(await start(pair.src, pair.tgt, aliveTv), llops, limits);
  };

  test("verifies e1", async () => expect(await run("e1")).toBe("verified"), 60_000);

  test("leaves e4, which is no refinement, unknown", async () => {
    expect(await run("e4")).toBe("unknown");
  }, 120_000);

  test("refutes a pair at the root", async () => {
    const src = "define i32 @f(i32 %x) {\nentry:\n  %r = add i32 %x, 1\n  ret i32 %r\n}\n";
    const session = await start(src, src.replace("add i32 %x, 1", "add i32 %x, 2"), aliveTv);
    expect(await search(session, llops, limits)).toBe("counterexample");
  }, 60_000);
});
