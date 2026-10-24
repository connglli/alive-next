// Tests the facts the simple searcher asks for: what the analyses know, kept
// to values that cannot be poison except for a range at a cut, and a window
// that only proves with them.
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
import { cutFacts, factsAt, passedOn, union, violated } from "../simple/facts.ts";
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

  test("treat a value a branch keeps from poison as noundef, in the range the branch allows", async () => {
    // Branching on %c is undefined behavior when %j is poison, so %j cannot be
    // poison at %d.
    const module = `define i32 @f(i32 %j) {
entry:
  %c = icmp sgt i32 %j, -1
  br i1 %c, label %then, label %exit

then:
  %d = add i32 %j, 1
  ret i32 %d

exit:
  ret i32 0
}
`;
    expect(await factsAt(llops, module, "%d", ["%j"])).toEqual({
      "%j": { noundef: true, range: { min: 0, max: -2147483648 } },
    });
    const cut = await cutFacts(llops, module, "%d", ["%j"]);
    expect(cut.param_attrs).toEqual({ 0: { noundef: true } });
    expect(cut.predicates).toContainEqual({ op: "sge", lhs: "!0", rhs: 0 });
  });

  test("narrow a value by its known bits, which see the branch before it", async () => {
    // Only the known bits use that %lo <= %hi on the way to %h, so %d >= 0.
    // The load after makes a poison %d undefined behavior.
    const module = `define i32 @f(ptr %a, i32 %lo, i32 %hi) {
entry:
  %c = icmp sle i32 %lo, %hi
  br i1 %c, label %then, label %exit

then:
  %d = sub nsw i32 %hi, %lo
  %h = sdiv i32 %d, 2
  %e = sext i32 %h to i64
  %p = getelementptr inbounds i32, ptr %a, i64 %e
  %v = load i32, ptr %p
  ret i32 %v

exit:
  ret i32 -1
}
`;
    expect(await factsAt(llops, module, "%h", ["%d"])).toEqual({
      "%d": { noundef: true, range: { min: 0, max: -2147483648 } },
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

  test("give a cut's input that may be poison its narrowest range, and no predicate", async () => {
    // %a's range comes from its known bits as well, and %u's from the remainder,
    // narrower than its known bits; %y narrows to nothing.
    const module = `define i32 @f(i32 %y, i32 noundef %n) {
entry:
  %a = and i32 %y, 255
  %u = urem i32 %y, 10
  %k = and i32 %n, 15
  %r = add i32 %a, %u
  %s = add i32 %r, %k
  ret i32 %s
}
`;
    const facts = await cutFacts(llops, module, "%s", ["%a", "%u", "%y", "%k"]);
    expect(facts.param_attrs).toEqual({
      0: { range: { min: 0, max: 256 } },
      1: { range: { min: 0, max: 10 } },
      3: { noundef: true },
    });
    expect(JSON.stringify(facts.predicates)).not.toMatch(/!0|!1|!2/);
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

describe("violated", () => {
  test("names the guessed comparisons a counterexample breaks, past a poison input", () => {
    const detail = `ERROR: Value mismatch

Example:
i8 noundef %#0 = #xff (255, -1)
i8 %#1 = #x01 (1)
i8 %#2 = poison

Source:
i8 %#3 = #x00 (0)
`;
    const broken = violated(detail).map(({ op, lhs, rhs }) => `${lhs} ${op} ${rhs}`);
    // 255 is -1 signed, and above 1 unsigned.
    expect(broken).toContain("!0 sge 0");
    expect(broken).toContain("!0 ule !1");
    expect(broken).not.toContain("!1 ule !0");
    expect(broken.filter((comparison) => comparison.includes("!2"))).toEqual([]);
  });
});

describe("passedOn", () => {
  test("renames facts for a cut and drops those about values it does not pass", () => {
    const relation = { insts: ["%d = sub i32 !2, !0", "%ok = icmp ne i32 %d, 0"] };
    const facts = [{ op: "ule" as const, lhs: "!0", rhs: "!2" }, relation, EQ];
    // The cut passes a value of its own first, then %2 and %0, but not %1.
    expect(passedOn(facts, ["%5", "%2", "%0"])).toEqual([
      { op: "ule", lhs: "!2", rhs: "!1" },
      { insts: ["%d = sub i32 !1, !2", "%ok = icmp ne i32 %d, 0"] },
    ]);
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
      timeouts: timeoutsFrom({ checkDefaultMs: 5_000 }),
    });
    expect(await stepWindows(session, llops, "g1", grow(1))).toEqual([]);
  }, 60_000);
});
