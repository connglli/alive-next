// Certifying a counterexample.
//
// llops is real, since a harness is real IR and building one is most of the
// move. The interpreter is a stand-in, so what is under test is the rule that
// reads two runs and what the framework does with it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Llops } from "../core/drivers/llops.ts";
import type { RunResult } from "../core/drivers/llubi.ts";
import { Counterexamples, divergence, type Interpreter } from "../core/state/counterexamples.ts";
import { applyEffect, derive, type Tree, verdict } from "../core/state/goals.ts";
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

/** UB at the store the harness makes to observe the result, which is poison. */
function poison(): RunResult {
  return {
    outcome: "ub",
    observations: {},
    reason: "store poison value is UB",
    at: "store i32 %2, ptr %result.slot, align 4 at @main",
    trace: "",
    ms: 1,
  };
}

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

async function asked(): Promise<Tree> {
  const src = await store.put(SRC);
  const tgt = await store.put(TGT);
  events.push({ kind: "run_start", src, tgt, config: {}, versions: {} });
  return replay();
}

const INPUT = [{ kind: "int", value: "-3" } as const];

describe("the divergence rule", () => {
  test("a tgt with UB where the src returned is a refutation", () => {
    const found = divergence(ran("i32 1"), ub("division by zero"));
    expect(found.confirmed).toBe(true);
    expect(found.reason).toContain("the tgt has UB");
  });

  test("a tgt that returns poison is told from one with UB of its own", () => {
    // The harness stops at its own store, so the program itself had no UB.
    const found = divergence(ran("i32 1"), poison());
    expect(found.confirmed).toBe(true);
    expect(found.reason).toBe("the tgt returns poison where the src returns a value");
  });

  test("a src with UB settles nothing, since every target refines it", () => {
    const found = divergence(ub("division by zero"), ran("i32 1"));
    expect(found.confirmed).toBe(false);
    expect(found.reason).toContain("every target refines it");
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
  test("a divergence refutes the root", async () => {
    const tree = await asked();
    const interp = new Canned([ran("i32 -1"), ran("i32 -2")]);
    const result = await new Counterexamples(store, llops, interp).report(tree, INPUT);

    if (result.kind !== "refuted") throw new Error(result.reason);
    expect(result.effects).toEqual([{ effect: "refuted", gid: "g1" }]);
    expect(result.divergence).toContain("i32 -1 in the src and i32 -2 in the tgt");
    for (const effect of result.effects) applyEffect(tree, effect);
    expect(verdict(tree)).toBe("counterexample");

    // Both sides were run, each wrapped in a main llubi can enter.
    expect(interp.modules).toHaveLength(2);
    expect(interp.modules[0]).toContain("call i32 @f(i32 -3)");
    expect(interp.modules[1]).toContain("ashr");
  });

  test("runs the pair the run was asked about, not the one it has reached", async () => {
    await asked();
    // A step the search made, which a counterexample says nothing about.
    const moved = await store.put(SRC.replace("sdiv i32 %x, 2", "sdiv i32 %x, 4"));
    events.push({
      kind: "tool_result",
      id: "1",
      tool: "commit",
      effects: [{ effect: "step", gid: "g1", side: "src", to: moved, how: "checked" }],
      result: null,
      ms: 1,
    });

    const interp = new Canned([ran("i32 -1"), ran("i32 -2")]);
    await new Counterexamples(store, llops, interp).report(replay(), INPUT);
    expect(interp.modules[0]).toContain("sdiv i32 %0, 2");
  });

  test("says nothing was shown when the two runs agree", async () => {
    const tree = await asked();
    const interp = new Canned([ran("i32 -1"), ran("i32 -1")]);
    const result = await new Counterexamples(store, llops, interp).report(tree, INPUT);

    expect(result).toMatchObject({ kind: "refused", reason: "the two runs agree" });
    if (result.kind !== "refused") throw new Error("unreachable");
    // What it saw comes back either way, since that is what a search reads.
    expect(result.replay?.entry).toBe("f");
  });

  test("refuses an input the harness cannot be built from", async () => {
    const tree = await asked();
    const interp = new Canned([]);
    const result = await new Counterexamples(store, llops, interp).report(tree, [
      { kind: "int", value: "wat" },
    ]);
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("the src harness");
  });

  test("refuses a src that is free to choose what it does", async () => {
    // One run of a src with a freeze in it is one of its behaviours, and the
    // tgt is allowed any of them.
    const src = await store.put(`define i32 @f(i32 noundef %x) {
entry:
  %f = freeze i32 %x
  %h = sdiv i32 %f, 2
  ret i32 %h
}
`);
    const tgt = await store.put(TGT);
    events.push({ kind: "run_start", src, tgt, config: {}, versions: {} });
    const result = await new Counterexamples(store, llops, new Canned([])).report(replay(), INPUT);

    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("free to choose (freeze)");
  });

  test("refuses a proved root, where a divergence would be a contradiction", async () => {
    const tree = await asked();
    applyEffect(tree, { effect: "proved", gid: "g1" });
    const result = await new Counterexamples(store, llops, new Canned([])).report(tree, INPUT);
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("g1 is proved");
  });
});
