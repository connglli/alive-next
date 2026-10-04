// Tests the facts the simple searcher asks for: what the analyses know, kept
// to values that cannot be poison, and a window that only proves with them.
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
import { factsAt, union } from "../simple/facts.ts";
import { DEFAULT_LIMITS } from "../simple/limits.ts";
import { stepWindows } from "../simple/windows.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
/** A comparison a guess and a relation can both state. */
const EQ = { op: "eq" as const, lhs: "!0", rhs: "!1" };
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

describe.skipIf(!built)("facts", () => {
  test("come from the analyses, for values that cannot be poison", async () => {
    const module = `define i32 @f(i32 noundef range(i32 0, 100) %x, i32 %y, ptr noundef nonnull align 8 dereferenceable(16) %p) {
entry:
  %a = and i32 %y, 255
  %fy = freeze i32 %y
  %b = and i32 %fy, 255
  %r = add i32 %x, %b
  ret i32 %r
}
`;
    const facts = await factsAt(llops, module, "%r", ["%x", "%y", "%p", "%a", "%fy", "%b"]);
    expect(facts).toEqual({
      "%x": { noundef: true, range: { min: 0, max: 100 } },
      "%p": { noundef: true, nonnull: true, align: 8, dereferenceable: 16 },
      "%fy": { noundef: true },
      "%b": { noundef: true, range: { min: 0, max: 256 } },
    });
  });

  test("a range that reaches the top of its type wraps, and one too wide to send is left out", async () => {
    const module = `define i64 @f(i8 noundef %x, i64 noundef %y) {
entry:
  %h = lshr i8 %x, 1
  %w = lshr i64 %y, 1
  %z = zext i8 %h to i64
  %r = add i64 %z, %w
  ret i64 %r
}
`;
    const facts = await factsAt(llops, module, "%r", ["%h", "%w"]);
    expect(facts).toEqual({
      "%h": { noundef: true, range: { min: 0, max: -128 } },
      "%w": { noundef: true },
    });
  });
});

const noRun: Interpreter = {
  run() {
    throw new Error("this session has no interpreter");
  },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-facts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("candidates", () => {
  test("are each stated once, with the analyses' attributes over a guess's", () => {
    const guess = { param_attrs: { 0: { noundef: true } }, predicates: [EQ] };
    const facts = { param_attrs: { 0: { noundef: true, nonnull: true } } };
    expect(union(guess, facts, { predicates: [EQ] })).toEqual({
      param_attrs: { 0: { noundef: true, nonnull: true } },
      predicates: [EQ],
    });
  });
});

describe.skipIf(!solving)("facts with alive-tv", () => {
  test("a window over an argument proves with the argument's facts", async () => {
    // Whole-function questions get no answer, so only a window can certify the step.
    const windowsOnly: Checker = {
      async check(src, tgt, options): Promise<CheckResult> {
        if (src.includes("@outlined_window") || tgt.includes("@llvm.assume"))
          return aliveTv.check(src, tgt, options);
        return {
          outcome: "unknown",
          detail: "",
          invocation: { binary: "stub", flags: [], timeoutMs: 0 },
          stdout: "",
          ms: 0,
        };
      },
    };
    const src = `define i32 @f(i32 noundef range(i32 0, 100) %x, i32 %y) {
entry:
  %a = add i32 %x, 1
  %r = mul i32 %a, %y
  ret i32 %r
}
`;
    const session = await Session.start({
      dir: join(dir, "argument"),
      src,
      tgt: src.replace("add i32", "add nuw nsw i32"),
      llops,
      checker: windowsOnly,
      interp: noRun,
      rewriter: {} as Llrwt,
      timeouts: timeoutsFrom({ alive2Ms: 5_000 }),
    });
    expect(await stepWindows(session, llops, "g1", grow(1))).toEqual([]);
  }, 60_000);
});
