// Certified steps.
//
// The checker is a stand-in that records what it was asked, because what
// matters here is which pair goes to alive2 and which way round, not what
// alive2 would say about it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckOutcome, CheckResult } from "../core/drivers/alive2.ts";
import { DEFAULT_ASSUMPTION } from "../core/state/arguments.ts";
import { derive } from "../core/state/goals.ts";
import { DEFAULT_TIMEOUTS, orient, Steps, timeoutsFrom } from "../core/state/steps.ts";
import { Store } from "../core/state/store.ts";
import type { Entry, Event } from "../core/state/trajectory.ts";

/** Remembers every call, and answers whatever the test lined up. */
class FakeChecker {
  readonly calls: { src: string; tgt: string; timeoutMs?: number; flags?: string[] }[] = [];
  constructor(private outcomes: CheckOutcome[]) {}

  async check(
    src: string,
    tgt: string,
    options?: { timeoutMs?: number; flags?: string[] },
  ): Promise<CheckResult> {
    this.calls.push({ src, tgt, timeoutMs: options?.timeoutMs, flags: options?.flags });
    const outcome = this.outcomes.shift() ?? "unknown";
    return {
      outcome,
      detail: outcome === "incorrect" ? "Example:\ni32 %x = 1" : "",
      invocation: { binary: "alive-tv", flags: [], timeoutMs: options?.timeoutMs ?? 0 },
      stdout: "",
      ms: 1,
    };
  }
}

const SRC = "define i32 @f() {\nentry:\n  ret i32 1\n}\n";
/** A narrowing, as the caller hands one over: three programs and where they were. */
const OUTER = "define i32 @f() {\nentry:\n  %0 = call i32 @outlined_window()\n  ret i32 %0\n}\n";
const WAS = "define i32 @outlined_window() {\nentry:\n  ret i32 1\n}\n";
const NOW = "define i32 @outlined_window() {\nentry:\n  ret i32 3\n}\n";
const WINDOW = {
  outer: OUTER,
  before: WAS,
  after: NOW,
  callee: "outlined_window",
  at: { before: { from: "#0", to: "#0" }, after: { from: "#0", to: "#0" } },
};
const TGT = "define i32 @f() {\nentry:\n  ret i32 2\n}\n";
const NEW = "define i32 @f() {\nentry:\n  ret i32 3\n}\n";

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-steps-"));
  store = new Store(join(dir, "store"), async (text) => text);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function tree(...events: Event[]) {
  const src = await store.put(SRC);
  const tgt = await store.put(TGT);
  const start: Event[] = [{ kind: "run_start", src, tgt, config: {}, versions: {} }];
  return derive([...start, ...events].map((event) => ({ ...event, time: 0, prev: "" }) as Entry));
}

/** The same run, told that its arguments are defined but may be poison. */
async function assuming(...events: Event[]) {
  const src = await store.put(SRC);
  const tgt = await store.put(TGT);
  const start: Event[] = [
    { kind: "run_start", src, tgt, assumed: DEFAULT_ASSUMPTION, config: {}, versions: {} },
  ];
  return derive([...start, ...events].map((event) => ({ ...event, time: 0, prev: "" }) as Entry));
}

/** A cut of the root, which is what puts a goal below one. */
function cutG1(src: string, tgt: string): Event {
  return {
    kind: "tool_result",
    id: "1",
    tool: "split",
    effects: [
      {
        effect: "split",
        gid: "g1",
        name: "outlined_g3",
        outer: { gid: "g2", src, tgt },
        callee: { gid: "g3", src, tgt },
      },
    ],
    result: null,
    ms: 1,
  };
}

describe("timeouts", () => {
  test("the configuration overrides only what it names", () => {
    const timeouts = timeoutsFrom({ eagerCheckMs: 100 });
    expect(timeouts.eagerCheckMs).toBe(100);
    expect(timeouts.alive2Ms).toBe(DEFAULT_TIMEOUTS.alive2Ms);
  });

  test("a section that names nothing leaves the defaults", () => {
    expect(timeoutsFrom({})).toEqual(DEFAULT_TIMEOUTS);
    expect(timeoutsFrom({ checkCapMs: undefined })).toEqual(DEFAULT_TIMEOUTS);
  });
});

describe("orient", () => {
  test("a src step asks whether the new program refines the old", () => {
    expect(orient("src", "old", "new")).toEqual({ src: "old", tgt: "new" });
  });

  test("a tgt step asks the reverse", () => {
    // Deoptimising backward: the old target has to refine the new one, so the
    // new one is what alive2 is given as src.
    expect(orient("tgt", "old", "new")).toEqual({ src: "new", tgt: "old" });
  });
});

describe("stepping", () => {
  test("sends the pair in the src direction and advances the head", async () => {
    const checker = new FakeChecker(["correct", "unknown"]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await tree(), "g1", "src", NEW);

    if (result.kind !== "certified") throw new Error("expected the step to land");
    expect(checker.calls[0]).toMatchObject({ src: SRC, tgt: NEW });
    expect(result.effects[0]).toEqual({
      effect: "step",
      gid: "g1",
      side: "src",
      to: result.hash,
      how: "checked",
    });
  });

  test("sends the pair the other way round for a tgt step", async () => {
    const checker = new FakeChecker(["correct", "unknown"]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await tree(), "g1", "tgt", NEW);

    if (result.kind !== "certified") throw new Error("expected the step to land");
    expect(checker.calls[0]).toMatchObject({ src: NEW, tgt: TGT });
  });

  test("refuses a step alive2 will not certify, leaving the head alone", async () => {
    const checker = new FakeChecker(["incorrect"]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await tree(), "g1", "src", NEW);

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.check.detail).toContain("Example:");
    // One call only: nothing was certified, so nothing was cross-checked.
    expect(checker.calls).toHaveLength(1);
  });

  test("checks the new pair after a step, and says when it discharges", async () => {
    const checker = new FakeChecker(["correct", "correct"]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await tree(), "g1", "src", NEW);

    if (result.kind !== "certified") throw new Error("expected the step to land");
    // The cross-check is the goal's own claim: does tgt refine the new src?
    expect(checker.calls[1]).toMatchObject({ src: NEW, tgt: TGT });
    expect(checker.calls[1]?.timeoutMs).toBe(DEFAULT_TIMEOUTS.eagerCheckMs);
    expect(result.effects[1]).toEqual({ effect: "proved", gid: "g1" });
  });

  test("leaves the goal open when the cross-check settles nothing", async () => {
    const checker = new FakeChecker(["correct", "unknown"]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await tree(), "g1", "src", NEW);

    if (result.kind !== "certified") throw new Error("expected the step to land");
    expect(result.effects).toHaveLength(1);
    expect(result.eager?.outcome).toBe("unknown");
  });

  test("asks about the window first, and records what it asked", async () => {
    const checker = new FakeChecker(["correct", "unknown"]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await assuming(), "g1", "src", NEW, { narrowed: WINDOW });

    if (result.kind !== "certified") throw new Error("expected the step to land");
    expect(result.by).toBe("window");
    // The small pair, on the budget a cheap question gets, and asked under no
    // assumption: a window's parameters are values the program computed.
    expect(checker.calls[0]).toMatchObject({ src: WAS, tgt: NOW });
    expect(checker.calls[0]?.timeoutMs).toBe(DEFAULT_TIMEOUTS.eagerCheckMs);
    expect(checker.calls[0]?.flags).toEqual([]);

    const step = result.effects[0];
    if (step?.effect !== "step") throw new Error("expected a step effect");
    // The three halves are in the store, because a checker replays from them.
    expect(step.window?.callee).toBe("outlined_window");
    expect(store.get(step.window?.from as string)).toBe(WAS);
    expect(store.get(step.window?.to as string)).toBe(NOW);
    expect(store.get(step.window?.outer as string)).toBe(OUTER);
  });

  test("falls back to the whole function when the window settles nothing", async () => {
    const checker = new FakeChecker(["unknown", "correct", "unknown"]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await assuming(), "g1", "src", NEW, { narrowed: WINDOW });

    if (result.kind !== "certified") throw new Error("expected the step to land");
    expect(result.by).toBe("whole");
    // The whole pair, on the step budget, under what the goal is asked under.
    expect(checker.calls[1]).toMatchObject({ src: SRC, tgt: NEW });
    expect(checker.calls[1]?.timeoutMs).toBe(DEFAULT_TIMEOUTS.alive2Ms);
    expect(checker.calls[1]?.flags).toEqual(["--disable-undef-input"]);
    const step = result.effects[0];
    if (step?.effect !== "step") throw new Error("expected a step effect");
    // Nothing was narrowed in the end, so the step says nothing about a window.
    expect(step.window).toBeUndefined();
  });

  test("a refuted window refuses nothing, since its inputs are freer", async () => {
    // The window is asked about inputs the body around it may never produce,
    // so a counterexample there can be about the window rather than the step.
    const checker = new FakeChecker(["incorrect", "correct", "unknown"]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await tree(), "g1", "src", NEW, { narrowed: WINDOW });

    if (result.kind !== "certified") throw new Error("expected the step to land");
    expect(result.by).toBe("whole");
  });

  test("a refusal says whether the window was any easier", async () => {
    const checker = new FakeChecker(["unknown", "incorrect"]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await tree(), "g1", "src", NEW, { narrowed: WINDOW });

    if (result.kind !== "refused") throw new Error("expected the step to be refused");
    expect(result.check.outcome).toBe("incorrect");
    expect(result.narrowed?.outcome).toBe("unknown");
  });

  test("refuses a step to the program that is already there", async () => {
    const checker = new FakeChecker([]);
    const steps = new Steps(store, checker);
    const result = await steps.step(await tree(), "g1", "src", SRC);

    expect(result.kind).toBe("refused");
    // Nothing was asked of alive2, because nothing changed.
    expect(checker.calls).toHaveLength(0);
  });

  test("refuses to touch a goal that is not open", async () => {
    const steps = new Steps(store, new FakeChecker(["correct"]));
    await expect(steps.step(await tree(), "g9", "src", NEW)).rejects.toThrow(/no goal g9/);
  });
});

describe("checking a goal", () => {
  test("proves it when alive2 agrees", async () => {
    const steps = new Steps(store, new FakeChecker(["correct"]));
    const result = await steps.checkGoal(await tree(), "g1");
    expect(result.outcome).toBe("proved");
    expect(result.effects).toEqual([{ effect: "proved", gid: "g1" }]);
  });

  test("calls a refutation a hint, not a verdict", async () => {
    const steps = new Steps(store, new FakeChecker(["incorrect"]));
    const result = await steps.checkGoal(await tree(), "g1");
    expect(result.outcome).toBe("refuted");
    // Only execution certifies a counterexample, so the tree is left alone.
    expect(result.effects).toEqual([]);
  });

  test("leaves the goal open on a timeout", async () => {
    const steps = new Steps(store, new FakeChecker(["unknown"]));
    const result = await steps.checkGoal(await tree(), "g1");
    expect(result.outcome).toBe("unknown");
    expect(result.effects).toEqual([]);
  });

  test("asks the goal's own question, src against tgt", async () => {
    const checker = new FakeChecker(["correct"]);
    await new Steps(store, checker).checkGoal(await tree(), "g1");
    expect(checker.calls[0]).toMatchObject({ src: SRC, tgt: TGT });
  });

  test("honours the agent's timeout, up to the cap", async () => {
    const checker = new FakeChecker(["unknown", "unknown"]);
    const steps = new Steps(store, checker);
    const whole = await steps.checkGoal(await tree(), "g1", 1000);
    expect(checker.calls[0]?.timeoutMs).toBe(1000);
    // Nothing was cut down, so there is no second number to report.
    expect(whole.cappedFromMs).toBeUndefined();

    const capped = await steps.checkGoal(await tree(), "g1", DEFAULT_TIMEOUTS.checkCapMs * 10);
    expect(checker.calls[1]?.timeoutMs).toBe(DEFAULT_TIMEOUTS.checkCapMs);
    // A timeout on the cap is a different situation from a timeout on what
    // was asked for, so the result says which one it ran on.
    expect(capped.cappedFromMs).toBe(DEFAULT_TIMEOUTS.checkCapMs * 10);
  });

  test("carries the run's assumption, and stops at a cut", async () => {
    const checker = new FakeChecker(["unknown", "unknown", "unknown"]);
    const steps = new Steps(store, checker);
    const src = await store.put(SRC);

    await steps.checkGoal(await assuming(), "g1");
    const withCut = await assuming(cutG1(src, src));
    await steps.checkGoal(withCut, "g2");
    await steps.checkGoal(withCut, "g3");
    expect(checker.calls[0]?.flags).toEqual(["--disable-undef-input"]);
    // The outer half still has the arguments the run was given.
    expect(checker.calls[1]?.flags).toEqual(["--disable-undef-input"]);
    // The callee's parameters are values the program computed, and a program
    // can produce undef whatever it was handed.
    expect(checker.calls[2]?.flags).toEqual([]);
  });

  test("assumes nothing where the log stated nothing", async () => {
    const checker = new FakeChecker(["unknown"]);
    await new Steps(store, checker).checkGoal(await tree(), "g1");
    expect(checker.calls[0]?.flags).toEqual([]);
  });

  test("reports the budgets it resolved to", () => {
    const steps = new Steps(store, new FakeChecker([]), timeoutsFrom({ eagerCheckMs: 100 }));
    expect(steps.budgets.eagerCheckMs).toBe(100);
    expect(steps.budgets.alive2Ms).toBe(DEFAULT_TIMEOUTS.alive2Ms);
  });
});
