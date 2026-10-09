// Certifying a counterexample.
//
// llops is real, since putting the input into the pair and wrapping a side in
// a harness are most of the move. alive2 and llubi are stand-ins, so what is
// under test is what each is asked, the rule that reads two runs, and what the
// framework does with the answers.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckOutcome, CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import type { RunResult } from "../core/drivers/llubi.ts";
import { Counterexamples, divergence, type Interpreter } from "../core/state/counterexamples.ts";
import { applyEffect, derive, type Tree, verdict } from "../core/state/goals.ts";
import { DEFAULT_TIMEOUTS, Steps } from "../core/state/steps.ts";
import { Store } from "../core/state/store.ts";
import type { Entry, Event } from "../core/state/trajectory.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

const SRC = `define i32 @f(i32 noundef %x) {
entry:
  %h = sdiv i32 %x, 2
  ret i32 %h
}
`;
const TGT = `define i32 @f(i32 noundef %x) {
entry:
  %h = ashr i32 %x, 1
  ret i32 %h
}
`;
const LOOP = `define i32 @f(i32 noundef %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %next, %loop ]
  %next = add i32 %i, 1
  %done = icmp uge i32 %next, %n
  br i1 %done, label %exit, label %loop

exit:
  ret i32 %next
}
`;

/** A checker that answers from a script, keeping what it was asked. */
class Solver {
  readonly asked: { src: string; tgt: string; flags: string[]; timeoutMs?: number }[] = [];
  constructor(private readonly outcomes: CheckOutcome[]) {}
  async check(
    src: string,
    tgt: string,
    options?: { flags?: string[]; timeoutMs?: number },
  ): Promise<CheckResult> {
    const flags = options?.flags ?? [];
    this.asked.push({ src, tgt, flags, timeoutMs: options?.timeoutMs });
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error("the stand-in was asked for one check too many");
    const detail = { correct: "", incorrect: "ERROR: Value mismatch", unknown: "ERROR: Timeout" };
    return {
      outcome,
      detail: detail[outcome as keyof typeof detail] ?? "",
      invocation: { binary: "solver", flags, timeoutMs: 0 },
      stdout: "",
      ms: 1,
    };
  }
}

/** An interpreter that answers from a script, keeping what it was given. */
class Canned implements Interpreter {
  readonly modules: string[] = [];
  constructor(private readonly runs: RunResult[]) {}
  async run(module: string): Promise<RunResult> {
    this.modules.push(module);
    const next = this.runs.shift();
    if (!next) throw new Error("the stand-in was asked for one run too many");
    return next;
  }
}

function ran(result: string): RunResult {
  return {
    outcome: "returned",
    observations: { "%obs.result": result },
    reason: "",
    trace: "",
    ms: 1,
  };
}

/** UB inside the program, which is the program's own. */
function ub(reason: string): RunResult {
  return {
    outcome: "ub",
    observations: {},
    reason,
    at: "%1 = sdiv i32 %0, 0 at @f",
    trace: "",
    ms: 1,
  };
}

/** A stand-in for llrwt that refuses any use, since nothing here rewrites. */
const unrewriting = {
  apply: async () => ({ ok: false as const, code: "unavailable", message: "unused" }),
} as unknown as Llrwt;

let dir: string;
let store: Store;
let events: Event[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-cex-"));
  store = new Store(join(dir, "store"), async (text) => {
    const result = await llops.canon(text);
    if (!result.ok) throw new Error(result.message);
    return result.module;
  });
  events = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The run as its log says it stands. */
function replay(): Tree {
  return derive(events.map((event) => ({ ...event, time: 0, prev: "" }) as Entry));
}

async function asked(src = SRC, tgt = TGT): Promise<Tree> {
  const start = { src: await store.put(src), tgt: await store.put(tgt) };
  events.push({ kind: "start", ...start, config: {}, versions: {} });
  return replay();
}

function reporter(solver: Solver, interp: Canned): Counterexamples {
  const steps = new Steps(store, solver, DEFAULT_TIMEOUTS, llops, unrewriting);
  return new Counterexamples(store, llops, steps, interp);
}

const INPUT = [{ kind: "int", value: "-3" } as const];

describe("the divergence rule", () => {
  test("a tgt with UB where the src returned is a refutation", () => {
    const found = divergence(ran("i32 1"), ub("division by zero"));
    expect(found.confirmed).toBe(true);
    expect(found.reason).toContain("the tgt has UB");
  });

  test("a src with UB settles nothing, since every target refines it", () => {
    const found = divergence(ub("division by zero"), ran("i32 1"));
    expect(found.confirmed).toBe(false);
    expect(found.reason).toContain("every tgt refines it");
  });

  test("poison in the src allows any value, and poison in the tgt is a divergence", () => {
    expect(divergence(ran("poison"), ran("i32 1")).confirmed).toBe(false);
    expect(divergence(ran("i32 1"), ran("poison"))).toEqual({
      confirmed: true,
      reason: "%obs.result is i32 1 in the src and poison in the tgt",
    });
  });

  test("a run llubi would not make is not evidence", () => {
    const broken: RunResult = {
      outcome: "error",
      observations: {},
      reason: "Cannot find entry function",
      trace: "",
      ms: 1,
    };
    expect(divergence(ran("i32 1"), broken).confirmed).toBe(false);
  });

  test("two runs that agree are not a counterexample", () => {
    expect(divergence(ran("i32 2"), ran("i32 2"))).toEqual({
      confirmed: false,
      reason: "the two runs agree",
    });
  });
});

describe.skipIf(!built)("reporting a counterexample", () => {
  test("alive2 refuting the pair at the input refutes the root, and llubi is not run", async () => {
    const tree = await asked();
    const solver = new Solver(["incorrect"]);
    const result = await reporter(solver, new Canned([])).report(tree, INPUT);

    if (result.kind !== "refuted") throw new Error(result.reason);
    expect(result).toMatchObject({ checker: "alive2", divergence: "ERROR: Value mismatch" });
    for (const effect of result.effects) applyEffect(tree, effect);
    expect(verdict(tree)).toBe("counterexample");
    // alive2 was asked about both programs with the input assumed at the entry.
    const [first] = solver.asked;
    if (!first) throw new Error("alive2 was not asked");
    for (const side of [first.src, first.tgt]) expect(side).toContain("icmp eq i32 %0, -3");
  });

  test("asks about the pair the run was asked about, not the one it has reached", async () => {
    await asked();
    // A step the search made, which a counterexample says nothing about.
    const moved = await store.put(SRC.replace("sdiv i32 %x, 2", "sdiv i32 %x, 4"));
    events.push({
      kind: "tool_result",
      id: "1",
      tool: "tx_commit",
      effects: [{ effect: "step", gid: "g1", side: "src", to: moved, how: "check" }],
      result: null,
      ms: 1,
    });

    const solver = new Solver(["incorrect"]);
    await reporter(solver, new Canned([])).report(replay(), INPUT);
    expect(solver.asked[0]?.src).toContain("sdiv i32 %0, 2");
  });

  test("alive2 finding no divergence on a pair that does not loop settles it", async () => {
    const tree = await asked();
    const interp = new Canned([]);
    const result = await reporter(new Solver(["correct"]), interp).report(tree, INPUT);
    expect(result).toMatchObject({
      kind: "refused",
      reason: "alive2 finds no divergence on this input",
    });
    expect(interp.modules).toHaveLength(0);
  });

  test("where alive2 times out, llubi runs the pair on the input", async () => {
    const tree = await asked();
    const solver = new Solver(["unknown"]);
    const interp = new Canned([ran("i32 -1"), ran("i32 -2")]);
    const result = await reporter(solver, interp).report(tree, INPUT, undefined, 5_000);
    // The agent chose what alive2 could spend before llubi took over.
    expect(solver.asked[0]?.timeoutMs).toBe(5_000);

    if (result.kind !== "refuted") throw new Error(result.reason);
    expect(result.checker).toBe("llubi");
    expect(result.divergence).toBe("%obs.result is i32 -1 in the src and i32 -2 in the tgt");
    // Both sides were run, each wrapped in a main llubi can enter.
    expect(interp.modules).toHaveLength(2);
    expect(interp.modules[0]).toContain("call i32 @f(i32 noundef -3)");
    expect(interp.modules[1]).toContain("ashr");
  });

  test("alive2 finding no divergence on a loop covers only what it unrolled", async () => {
    const tree = await asked(LOOP, LOOP.replace("ret i32 %next", "ret i32 %i"));
    const solver = new Solver(["correct"]);
    const interp = new Canned([ran("i32 2"), ran("i32 1")]);
    const result = await reporter(solver, interp).report(tree, [{ kind: "int", value: "2" }], 1);

    expect(result).toMatchObject({ kind: "refuted", checker: "llubi", unroll: 1 });
    expect(solver.asked[0]?.flags).toEqual([
      "--disable-undef-input",
      "--src-unroll=1",
      "--tgt-unroll=1",
    ]);
  });

  test("llubi does not stand in for a src it treats differently from alive2", async () => {
    const frozen = SRC.replace("%h = sdiv i32 %x, 2", "%y = freeze i32 %x\n  %h = sdiv i32 %y, 2");
    const tree = await asked(frozen);
    const interp = new Canned([]);
    const result = await reporter(new Solver(["unknown"]), interp).report(tree, INPUT);
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("llubi treats the src's freeze differently from alive2");
    expect(interp.modules).toHaveLength(0);
  });

  test("refuses an input the pair cannot be instantiated at", async () => {
    const tree = await asked();
    const result = await reporter(new Solver([]), new Canned([])).report(tree, [
      { kind: "int", value: "wat" },
    ]);
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("the input:");
  });

  test("refuses a proved root, where a divergence would be a contradiction", async () => {
    const tree = await asked();
    applyEffect(tree, { effect: "proved", gid: "g1" });
    const result = await reporter(new Solver([]), new Canned([])).report(tree, INPUT);
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("g1 is already proved, so no input can refute it");
  });
});
