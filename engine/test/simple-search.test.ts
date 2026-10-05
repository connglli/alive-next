// Tests the simple searcher end to end: first with stand-in checkers, then with
// alive-tv on the small pairs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import { Llrwt } from "../core/drivers/llrwt.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { type Checker, timeoutsFrom } from "../core/state/steps.ts";
import { digits } from "../examples/digits.ts";
import { induction } from "../examples/induction.ts";
import { nested } from "../examples/nested.ts";
import { DEFAULT_LIMITS, type Limits } from "../simple/limits.ts";
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
const llrwt = new Llrwt(toolchain.path("llrwt"), 30_000, {
  mlirTranslate: toolchain.mlir("mlir-translate"),
  mlirOpt: toolchain.mlir("mlir-opt"),
});
const rewriting =
  solving &&
  (await llrwt
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

function start(
  src: string,
  tgt: string,
  checker: Checker,
  alive2Ms = 5_000,
  rewriter = {} as Llrwt,
) {
  return Session.start({
    dir: join(dir, "run"),
    src,
    tgt,
    llops,
    checker,
    interp: {} as Interpreter,
    rewriter,
    timeouts: timeoutsFrom({ alive2Ms, checkDefaultMs: 5_000 }),
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
    // A cut before the multiplication, then the peel's two in what precedes it.
    expect(moves(session).filter((move) => move === "split")).toHaveLength(3);
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

describe.skipIf(!solving)("bun run simple", () => {
  test("ends the whole run when its time is up, and leaves no check running", async () => {
    // varA's root check alone takes its whole budget, so the time runs out in it.
    const [src, tgt, run] = [join(dir, "src.ll"), join(dir, "tgt.ll"), join(dir, "run")];
    writeFileSync(src, pairs.varA?.src ?? "");
    writeFileSync(tgt, pairs.varA?.tgt ?? "");
    const started = Date.now();
    const child = Bun.spawn(["bun", "run", "simple/main.ts", "--seconds", "3", src, tgt, run], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, TMPDIR: dir },
      stdout: "pipe",
    });
    const out = await new Response(child.stdout).text();
    await child.exited;
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(out).toContain("out of time");
    expect(out).toContain("unknown in");
    // A check still running would name files in the temporary directory.
    expect(spawnSync("pgrep", ["-f", dir]).stdout.toString()).toBe("");
  }, 30_000);
});

describe.skipIf(!solving)("search with alive-tv", () => {
  const run = async (name: string, more: Partial<Limits> = {}, alive2Ms?: number) => {
    const pair = pairs[name];
    if (!pair) throw new Error(`no pair ${name}`);
    return search(await start(pair.src, pair.tgt, aliveTv, alive2Ms), llops, {
      ...limits,
      ...more,
    });
  };

  test.each(["e1", "e1alt", "e2", "e3", "varB"])(
    "verifies %s through its windows",
    async (name) => expect(await run(name)).toBe("verified"),
    60_000,
  );

  test("verifies varA through the optimizer's stages", async () => {
    // instcombine adds the nsw itself, and the whole-function step to its stage
    // takes alive2 longer than a window gets.
    expect(await run("varA", { stages: true }, 30_000)).toBe("verified");
  }, 180_000);

  test("leaves e4, which is no refinement, unknown", async () => {
    expect(await run("e4")).toBe("unknown");
  }, 120_000);

  test.each([induction, nested])(
    "cuts the loops of $name at their headers and proves them by induction",
    async (scenario) => {
      const session = await start(scenario.src, scenario.tgt, aliveTv);
      expect(await search(session, llops, limits)).toBe("verified");
      expect(moves(session)).toContain("split");
    },
    60_000,
  );

  test.skipIf(!rewriting)(
    "verifies digits, whose iteration only a rule closes",
    async () => {
      const session = await start(digits.src, digits.tgt, aliveTv, undefined, llrwt);
      expect(await search(session, llops, limits)).toBe("verified");
      expect(moves(session)).toContain("rewrite");
    },
    120_000,
  );

  test("refutes a pair at the root", async () => {
    const src = "define i32 @f(i32 %x) {\nentry:\n  %r = add i32 %x, 1\n  ret i32 %r\n}\n";
    const session = await start(src, src.replace("add i32 %x, 1", "add i32 %x, 2"), aliveTv);
    expect(await search(session, llops, limits)).toBe("counterexample");
  }, 60_000);
});
