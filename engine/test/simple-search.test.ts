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
import { PAPER, pairs } from "./simple-pairs.ts";
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

/** An answer alive2 can give. */
type Outcome = CheckResult["outcome"];

/** A stand-in that answers each check with what `outcome` says of its src. */
function answering(outcome: (src: string, asked: number) => Outcome): Checker {
  let asked = 0;
  return {
    async check(src): Promise<CheckResult> {
      return {
        outcome: outcome(src, asked++),
        detail: "",
        invocation: { binary: "stub", flags: [], timeoutMs: 0 },
        stdout: "",
        ms: 0,
      };
    },
  };
}

/** A stand-in that answers `correct` where `proves` says so, and settles nothing else. */
function stub(proves: (src: string, asked: number) => boolean): Checker {
  return answering((src, asked) => (proves(src, asked) ? "correct" : "unknown"));
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

/** The tools the run called, in order, with what each was asked. */
function calls(session: Session): { tool: string; args: Record<string, unknown> }[] {
  const lines = readFileSync(join(session.dir, "trajectory.jsonl"), "utf8").split("\n");
  return lines.filter(Boolean).flatMap((line) => {
    const entry = JSON.parse(line);
    return entry.kind === "tool_call" ? [entry] : [];
  });
}

/** The tools the run called, in order. */
const moves = (session: Session) => calls(session).map((call) => call.tool);

/** A src the optimizer first takes out of memory, and then rewrites. */
const SPILLED = `define i32 @f(i32 noundef %x) {
entry:
  %x.addr = alloca i32, align 4
  store i32 %x, ptr %x.addr, align 4
  %0 = load i32, ptr %x.addr, align 4
  %mul = mul nsw i32 %0, 8
  ret i32 %mul
}
`;

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

  test("undoes the cut that left a refuted goal and cuts at the next point", async () => {
    const src = `define i32 @f(i32 %a, i32 %b, i32 %c) {
entry:
  %a1 = add i32 %a, 1
  %x = udiv i32 %a1, %b
  %y = udiv i32 %x, %c
  %r = add nuw i32 %y, 1
  ret i32 %r
}
`;
    // A callee that divides once, cut before the second division, is refuted,
    // and one that divides twice is proved; so is every outer, which calls it.
    const checker = answering((text) => {
      if (text.includes("@outlined_window")) return "unknown";
      const calls = text.includes("call");
      if (text.includes("define i32 @f(")) return calls ? "correct" : "unknown";
      return text.split("udiv").length === 2 ? "incorrect" : "correct";
    });
    const session = await start(src, src.replace("add nuw", "add"), checker);
    expect(await search(session, llops, limits)).toBe("verified");
    expect(moves(session).filter((move) => move === "split")).toHaveLength(2);
    expect(moves(session)).toContain("unsplit");
  });

  test("walks the src through the optimizer's stages", async () => {
    const stages = await llops.pipelineStages(SPILLED);
    if (!stages.ok) throw new Error(stages.message);
    const tgt = stages.stages.at(-1)?.module ?? SPILLED;
    // Everything but the first question, the root's, is proved.
    const session = await start(
      SPILLED,
      tgt,
      stub((_, asked) => asked > 0),
    );
    expect(await search(session, llops, { ...limits, stages: true })).toBe("verified");
    expect(moves(session).filter((move) => move === "tx_commit").length).toBeGreaterThan(0);
  });

  test("stops jumping to the stages once alive2 cannot decide a jump", async () => {
    const stages = await llops.pipelineStages(SPILLED);
    if (!stages.ok) throw new Error(stages.message);
    const tgt = stages.stages.at(-1)?.module ?? SPILLED;
    const session = await start(
      SPILLED,
      tgt,
      stub(() => false),
    );
    await search(session, llops, { ...limits, stages: true, cuts: 0 });
    const jumps = calls(session).filter((call) => call.args.op === "set_body");
    expect(jumps).toHaveLength(1);
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

  test("verifies the paper's straight-line pair by a cut and its facts", async () => {
    const session = await start(PAPER.src, PAPER.tgt, aliveTv);
    expect(await search(session, llops, limits)).toBe("verified");
  }, 300_000);

  test.skipIf(!rewriting)(
    "verifies digits, whose iteration only a rule closes",
    async () => {
      const session = await start(digits.src, digits.tgt, aliveTv, undefined, llrwt);
      expect(await search(session, llops, limits)).toBe("verified");
      expect(moves(session)).toContain("rewrite");
    },
    120_000,
  );

  test("strengthens the cut of a refuted callee against its counterexample", async () => {
    // The tgt's nuw needs m >= a, which the umax gives before the cut and no
    // analysis states; the callee's counterexample, with m < a, asks for it.
    const src = `define i32 @f(i32 noundef %a, i32 noundef %c, i32 noundef %d) {
entry:
  %m = call i32 @llvm.umax.i32(i32 %a, i32 %c)
  %q = udiv i32 %d, %m
  br label %next

next:
  %s = sub i32 %m, %a
  %r = add i32 %q, %s
  ret i32 %r
}

declare i32 @llvm.umax.i32(i32, i32)
`;
    // The whole function gets no answer, as a large one would.
    const silent = answering(() => "unknown");
    const large: Checker = {
      check: (src, tgt, options) =>
        src.includes("define i32 @f(") && !src.includes("@outlined")
          ? silent.check(src, tgt, options)
          : aliveTv.check(src, tgt, options),
    };
    const session = await start(src, src.replace("sub i32", "sub nuw i32"), large);
    expect(await search(session, llops, limits)).toBe("verified");
    expect(moves(session)).not.toContain("unsplit");
  }, 120_000);

  test("refutes a pair at the root", async () => {
    const src = "define i32 @f(i32 %x) {\nentry:\n  %r = add i32 %x, 1\n  ret i32 %r\n}\n";
    const session = await start(src, src.replace("add i32 %x, 1", "add i32 %x, 2"), aliveTv);
    expect(await search(session, llops, limits)).toBe("counterexample");
  }, 60_000);
});
