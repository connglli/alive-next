// Tests the simple searcher end to end: first with stand-in checkers, then with
// alive-tv on the small pairs.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certify } from "../cert/main.ts";
import { repoRoot } from "../core/config.ts";
import { AliveTv, type CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import { Llrwt } from "../core/drivers/llrwt.ts";
import { Llubi } from "../core/drivers/llubi.ts";
import { Session } from "../core/session.ts";
import { type Checker, timeoutsFrom } from "../core/state/steps.ts";
import { bounded } from "../examples/bounded.ts";
import { digits } from "../examples/digits.ts";
import { induction } from "../examples/induction.ts";
import { nested } from "../examples/nested.ts";
import { nestedinvariant } from "../examples/nestedinvariant.ts";
import { specialize } from "../examples/specialize.ts";
import { unroll } from "../examples/unroll.ts";
import { unswitch } from "../examples/unswitch.ts";
import { DEFAULT_LIMITS, type Limits } from "../simple/limits.ts";
import { refuteFrom } from "../simple/refute.ts";
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
const llubi = new Llubi(toolchain.path("llubi"));
const running =
  solving &&
  (await llubi
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

/** A pair to cut before either of its divisions, whose tgt drops a flag. */
const DIVIDES = `define i32 @f(i32 %a, i32 %b, i32 %c) {
entry:
  %a1 = add i32 %a, 1
  %x = udiv i32 %a1, %b
  %y = udiv i32 %x, %c
  %r = add nuw i32 %y, 1
  ret i32 %r
}
`;

/**
 * A pair whose tgt's nuw needs m >= a, which the umax gives before a cut at the
 * division and no analysis states; the callee's counterexample asks for it.
 */
const UMAX = `define i32 @f(i32 noundef %a, i32 noundef %c, i32 noundef %d) {
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

/**
 * A loop whose tgt counts down to its exit, so that past a cut inside the
 * iteration, its nuw holds only by the relation the loop's cut assumes.
 */
const SQUARES = `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %p = mul i32 %i, %i
  %q = mul i32 %p, %n
  %c = icmp ult i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %i.next = add i32 %i, 1
  br label %head

exit:
  ret i32 %q
}
`;

/** A stand-in that answers each check with what `outcome` says of its src and budget. */
function answering(outcome: (src: string, asked: number, ms: number) => Outcome): Checker {
  let asked = 0;
  return {
    async check(src, _, options): Promise<CheckResult> {
      return {
        outcome: outcome(src, asked++, options?.timeoutMs ?? 0),
        detail: "",
        invocation: { binary: "stub", flags: [], timeoutMs: 0 },
        stdout: "",
        ms: 0,
      };
    },
  };
}

/** A stand-in that answers `correct` where `proves` says so, and settles nothing else. */
function stub(proves: (src: string, asked: number, ms: number) => boolean): Checker {
  return answering((src, asked, ms) => (proves(src, asked, ms) ? "correct" : "unknown"));
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
  checkDefaultMs = 5_000,
  rewriter = {} as Llrwt,
) {
  return Session.start({
    dir: join(dir, "run"),
    src,
    tgt,
    llops,
    checker,
    interp: llubi,
    rewriter,
    timeouts: timeoutsFrom({ checkDefaultMs }),
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
  for (const disabled of [{ cuts: 0 }, { steps: false }])
    test(`bounded peeling respects ${Object.keys(disabled)[0]} being disabled`, async () => {
      const session = await start(
        bounded.src,
        bounded.tgt,
        stub(() => false),
      );
      expect(
        await search(session, llops, { ...limits, rules: false, facts: false, ...disabled }),
      ).toBe("unknown");
      expect(
        calls(session).some((call) => call.tool === "tx_edit" && call.args.op === "peel"),
      ).toBe(false);
    });

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
    // A cut before the multiplication, then two in what precedes it, each undone in turn.
    expect(await search(session, llops, { ...limits, cuts: 3 })).toBe("unknown");
    expect(moves(session).filter((move) => move === "cut")).toHaveLength(3);
    expect(moves(session).at(-1)).toBe("give_up");
  });

  test("undoes the cut that left a refuted goal and cuts at the next point", async () => {
    // A callee that divides once, cut before the second division, is refuted,
    // and one that divides twice is proved; so is every outer, which calls it.
    const checker = answering((text) => {
      if (text.includes("@outlined_window")) return "unknown";
      const calls = text.includes("call");
      if (text.includes("define i32 @f(")) return calls ? "correct" : "unknown";
      return text.split("udiv").length === 2 ? "incorrect" : "correct";
    });
    const session = await start(DIVIDES, DIVIDES.replace("add nuw", "add"), checker);
    expect(await search(session, llops, limits)).toBe("verified");
    expect(moves(session).filter((move) => move === "cut")).toHaveLength(2);
    expect(moves(session)).toContain("uncut");
  });

  test("undoes a cut whose goals stay open, so that the default check comes", async () => {
    // Only the whole function, on the default budget, gets an answer.
    const whole = (t: string) => t.includes("define i32 @f(") && !t.includes("call");
    const checker = stub((text, _, ms) => whole(text) && ms >= 5_000);
    const session = await start(DIVIDES, DIVIDES.replace("add nuw", "add"), checker);
    expect(await search(session, llops, { ...limits, cuts: 2 })).toBe("verified");
    expect(moves(session)).toContain("uncut");
  });

  test("gives a goal's last check the largest budget", async () => {
    // The whole function proves only past the default budget, which is 5 s here.
    const whole = (t: string) => t.includes("define i32 @f(") && !t.includes("call");
    const checker = stub((text, _, ms) => whole(text) && ms > 5_000);
    const session = await start(DIVIDES, DIVIDES.replace("add nuw", "add"), checker);
    expect(await search(session, llops, { ...limits, cuts: 0 })).toBe("verified");
  });

  test("cuts before each expensive operation when they outnumber the cuts", async () => {
    const src = `define i32 @f(i32 %a, i32 %b, i32 %c) {
entry:
  %x = udiv exact i32 %a, %b
  %y = udiv exact i32 %x, %c
  %z = udiv exact i32 %y, %a
  ret i32 %z
}
`;
    // A window, or a question that divides more than once, gets no answer.
    const once = (text: string) => text.split("udiv").length <= 2;
    const checker = stub((text) => !text.includes("@outlined_window") && once(text));
    const session = await start(src, src.replaceAll("udiv exact", "udiv"), checker);
    expect(await search(session, llops, { ...limits, cuts: 1 })).toBe("verified");
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

  test("asks no window again toward a tgt the stages end at", async () => {
    const src = "define i32 @f(i32 %x) {\nentry:\n  %m = mul i32 %x, 8\n  ret i32 %m\n}\n";
    const stages = await llops.pipelineStages(src);
    if (!stages.ok) throw new Error(stages.message);
    const tgt = stages.stages.at(-1)?.module ?? src;
    const asked: string[] = [];
    const session = await start(
      src,
      tgt,
      stub((src, _, ms) => asked.push(`${ms} ${src}`) < 0),
    );
    await search(session, llops, { ...limits, stages: true, cuts: 0 });
    expect(new Set(asked).size).toBe(asked.length);
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

  test("drops the tgt's loop IDs, which two of its loops share", async () => {
    const tgt = `define i32 @f(i32 %n) {
entry:
  br label %a

a:
  %i = phi i32 [ 0, %entry ], [ %i.next, %a ]
  %i.next = add i32 %i, 1
  %c = icmp slt i32 %i.next, %n
  br i1 %c, label %a, label %b, !llvm.loop !0

b:
  %j = phi i32 [ 0, %a ], [ %j.next, %b ]
  %j.next = add i32 %j, 1
  %d = icmp slt i32 %j.next, %n
  br i1 %d, label %b, label %e, !llvm.loop !0

e:
  ret i32 %j.next
}

!0 = distinct !{!0, !1}
!1 = !{!"llvm.loop.mustprogress"}
`;
    const src = tgt.replace("%i.next = add i32", "%i.next = add nsw i32");
    const session = await start(
      src,
      tgt,
      stub(() => false),
    );
    await search(session, llops, { ...limits, cuts: 0 });
    expect((await session.show("g1")).tgt.text).not.toContain("!llvm.loop");
  });

  test("interposes a stage alive2 cannot decide a jump to, though nothing loops", async () => {
    const stages = await llops.pipelineStages(SPILLED);
    if (!stages.ok) throw new Error(stages.message);
    const tgt = stages.stages.at(-1)?.module ?? SPILLED;
    const session = await start(
      SPILLED,
      tgt,
      stub(() => false),
    );
    // Nothing proves under the stub, so the search undoes the interpose later.
    await search(session, llops, { ...limits, stages: true, cuts: 1 });
    expect(moves(session)).toContain("interpose");
  }, 60_000);
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
  const run = async (name: string, more: Partial<Limits> = {}, checkDefaultMs?: number) => {
    const pair = pairs[name];
    if (!pair) throw new Error(`no pair ${name}`);
    return search(await start(pair.src, pair.tgt, aliveTv, checkDefaultMs), llops, {
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

  test("verifies a loop the tgt computes outright by peeling it away", async () => {
    const session = await start(bounded.src, bounded.tgt, aliveTv);
    expect(await search(session, llops, limits)).toBe("verified");
  }, 120_000);

  test("peels a bound exposed in a later goal and replays the certificate", async () => {
    // The pointer index width lets indvars expose the small bound after the root's analysis.
    const layout = `target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-i128:128-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-gnu"

`;
    const src = `${layout}@buffer = external global [4 x i32], align 4

define void @f(i32 noundef %n) {
entry:
  %i = alloca i32, align 4
  %large = icmp sgt i32 %n, 3
  br i1 %large, label %exit, label %init

init:
  store i32 0, ptr %i, align 4
  br label %head

head:
  %index = load i32, ptr %i, align 4
  %more = icmp slt i32 %index, %n
  br i1 %more, label %body, label %exit

body:
  %wide = sext i32 %index to i64
  %at = getelementptr inbounds i32, ptr @buffer, i64 %wide
  store i32 %index, ptr %at, align 4
  %next = add nsw i32 %index, 1
  store i32 %next, ptr %i, align 4
  br label %head

exit:
  ret void
}
`;
    const tgt = `${layout}@buffer = external global [4 x i32], align 4

define void @f(i32 noundef %n) {
entry:
  %before = sub i32 %n, 1
  %small = icmp ult i32 %before, 3
  br i1 %small, label %first, label %exit

first:
  %bound = zext nneg i32 %n to i64
  store i32 0, ptr @buffer, align 4
  %one = icmp eq i64 %bound, 1
  br i1 %one, label %exit, label %second

second:
  %p1 = getelementptr i32, ptr @buffer, i32 1
  store i32 1, ptr %p1, align 4
  %two = icmp eq i64 %bound, 2
  br i1 %two, label %exit, label %third

third:
  %p2 = getelementptr i32, ptr @buffer, i32 2
  store i32 2, ptr %p2, align 4
  br label %exit

exit:
  ret void
}
`;
    const session = await start(src, tgt, aliveTv);
    expect(
      await search(session, llops, { ...limits, stages: true, rules: false, counterexampleMs: 0 }),
    ).toBe("verified");
    expect(
      [...session.tree.goals.values()].some((goal) => goal.src_alone && goal.parent !== "g1"),
    ).toBe(true);
    session.finish();
    const pkg = certify(session.dir, join(session.dir, "certificate"));
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
  }, 180_000);

  test("proves a stage no step reaches as a goal of its own", async () => {
    // The optimizer divides unsigned and adds nuw since the counter is never
    // negative, which holds by induction, so no window or one query certifies it.
    const src = `declare void @use(i32)

define void @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %c = icmp slt i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %q = sdiv i32 %i, 3
  call void @use(i32 %q)
  %i.next = add nsw i32 %i, 1
  br label %head

exit:
  ret void
}
`;
    const stages = await llops.pipelineStages(src);
    if (!stages.ok) throw new Error(stages.message);
    const session = await start(src, stages.stages.at(-1)?.module ?? src, aliveTv);
    // Two cuts each, one per division and loop: the step needs one and the rest two,
    // so the step's cuts are its own.
    expect(await search(session, llops, { ...limits, stages: true, cuts: 1 })).toBe("verified");
    expect([...session.tree.goals.values()].some((goal) => goal.role === "lhs")).toBe(true);
  }, 180_000);

  test("bounds a sum of loaded bytes by a range, although it may be poison", async () => {
    // The remainder keeps the sum below 65521, so adding a byte cannot wrap,
    // which holds by induction. A loaded byte may be poison, and so may the
    // sum, so its loop cut can state the bound only as a range.
    const src = `define i32 @f(ptr noundef %p, i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %a = phi i32 [ 1, %entry ], [ %a.next, %body ]
  %c = icmp slt i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %idx = sext i32 %i to i64
  %q = getelementptr inbounds i8, ptr %p, i64 %idx
  %b = load i8, ptr %q
  %bz = zext i8 %b to i32
  %s = add i32 %a, %bz
  %a.next = urem i32 %s, 65521
  %i.next = add nsw i32 %i, 1
  br label %head

exit:
  ret i32 %a
}
`;
    const tgt = src.replace("%s = add i32 %a, %bz", "%s = add nuw nsw i32 %a, %bz");
    const session = await start(src, tgt, aliveTv);
    expect(await search(session, llops, limits)).toBe("verified");
  }, 180_000);

  test("drops the attributes a tgt's loop respects, so it can cut", async () => {
    const src = `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %s = phi i32 [ 0, %entry ], [ %s.next, %body ]
  %c = icmp slt i32 %i, %n
  br i1 %c, label %body, label %exit

body:
  %s.next = add i32 %s, %i
  %i.next = add nsw i32 %i, 1
  br label %head

exit:
  ret i32 %s
}
`;
    const tgt = src
      .replace("add i32 %s, %i", "add i32 %i, %s")
      .replace("%n) {", "%n) memory(none) {");
    const session = await start(src, tgt, aliveTv);
    expect(await search(session, llops, limits)).toBe("verified");
  }, 120_000);

  test("leaves e4, which is no refinement, unknown", async () => {
    expect(await run("e4")).toBe("unknown");
  }, 120_000);

  test.each([induction, nested, nestedinvariant])(
    "cuts the loops of $name at their headers and proves them by induction",
    async (scenario) => {
      const session = await start(scenario.src, scenario.tgt, aliveTv);
      expect(await search(session, llops, limits)).toBe("verified");
      expect(moves(session)).toContain("cut");
    },
    60_000,
  );

  test("proves a loop unswitched on a parameter by cases on it", async () => {
    const session = await start(unswitch.src, unswitch.tgt, aliveTv);
    expect(await search(session, llops, limits)).toBe("verified");
    expect(moves(session)).toContain("case");
  }, 180_000);

  test("splits by cases the stages that unswitch a loop and simplify it", async () => {
    const session = await start(specialize.src, specialize.tgt, aliveTv);
    expect(await search(session, llops, { ...limits, stages: true })).toBe("verified");
    expect(moves(session)).toContain("case");
  }, 180_000);

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
    // The whole function gets no answer, as a large one would.
    const silent = answering(() => "unknown");
    const large: Checker = {
      check: (src, tgt, options) =>
        src.includes("define i32 @f(") && !src.includes("@outlined")
          ? silent.check(src, tgt, options)
          : aliveTv.check(src, tgt, options),
    };
    const session = await start(UMAX, UMAX.replace("sub i32", "sub nuw i32"), large);
    expect(await search(session, llops, limits)).toBe("verified");
    expect(moves(session)).not.toContain("uncut");
  }, 120_000);

  test("searches again an outer that strengthening its cut reopened", async () => {
    // An outer holding an assume gets no answer on the short budget, so the
    // check a strengthen makes of it after it was proved does not prove it again.
    const silent = answering(() => "unknown");
    const slow: Checker = {
      check: (src, tgt, options) => {
        const whole = src.includes("define i32 @f(") && !src.includes("@outlined");
        const short = src.includes("@llvm.assume") && (options?.timeoutMs ?? 0) <= 3_000;
        return whole || (short && src.includes("define i32 @f("))
          ? silent.check(src, tgt, options)
          : aliveTv.check(src, tgt, options);
      },
    };
    const session = await start(UMAX, UMAX.replace("sub i32", "sub nuw i32"), slow);
    expect(await search(session, llops, limits)).toBe("verified");
  }, 120_000);

  test("offers a goal's assumed facts at the cuts inside it", async () => {
    // Both products asked against the tgt get no answer, as a large iteration would.
    const silent = answering(() => "unknown");
    const products = (src: string) => (src.match(/ = mul i32 %\d+, %\d+/g) ?? []).length;
    const large: Checker = {
      check: (src, tgt, options) =>
        products(src) >= 2 && !src.includes("add nuw") && tgt.includes("add nuw")
          ? silent.check(src, tgt, options)
          : aliveTv.check(src, tgt, options),
    };
    const left = "  %left = phi i32 [ %n, %entry ], [ %left.next, %body ]\n";
    const tgt = SQUARES.replace("%body ]\n", `%body ]\n${left}`)
      .replace("icmp ult i32 %i, %n", "icmp ne i32 %left, 0")
      .replace("add i32 %i, 1", "add nuw i32 %i, 1\n  %left.next = add i32 %left, -1");
    const session = await start(SQUARES, tgt, large);
    expect(await search(session, llops, limits)).toBe("verified");
  }, 120_000);

  test.skipIf(!running)(
    "refutes a loop by an unrolled check, which needs no report",
    async () => {
      const session = await start(unroll.src, unroll.tgt, aliveTv);
      expect(await search(session, llops, limits)).toBe("counterexample");
      expect(moves(session)).not.toContain("report_cex");
    },
    60_000,
  );

  test("stops once the unrolled check refutes the root, before any step", async () => {
    // An attribute the search would drop from the tgt is a step after the refutation.
    const tgt = unroll.tgt.replace(
      "define i32 @f(i32 noundef %n) {",
      "define i32 @f(i32 noundef %n) nofree {",
    );
    const session = await start(unroll.src, tgt, aliveTv);
    expect(await search(session, llops, limits)).toBe("counterexample");
  }, 60_000);

  test("reports a goal's counterexample whose input is poison", async () => {
    // Only a poison %x tells them apart: the tgt then returns poison, and the src 1.
    const src = "define i32 @f(i32 %x) {\nentry:\n  ret i32 1\n}\n";
    const same = "  %e = icmp eq i32 %x, %x\n  %r = zext i1 %e to i32\n  ret i32 %r";
    const session = await start(src, src.replace("  ret i32 1", same), aliveTv);
    const detail = "ERROR: Target is more poisonous\n\nExample:\ni32 %#0 = poison\n\n";
    expect(await refuteFrom(session, "g1", detail)).toBe(true);
    const report = calls(session).find((call) => call.tool === "report_cex");
    expect(report?.args.input).toEqual([{ kind: "poison" }]);
  }, 60_000);

  test("refutes a pair at the root", async () => {
    const src = "define i32 @f(i32 %x) {\nentry:\n  %r = add i32 %x, 1\n  ret i32 %r\n}\n";
    const session = await start(src, src.replace("add i32 %x, 1", "add i32 %x, 2"), aliveTv);
    expect(await search(session, llops, limits)).toBe("counterexample");
  }, 60_000);
});
