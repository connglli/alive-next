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
import { derive } from "../core/state/goals.ts";
import { DEFAULT_TIMEOUTS, orient, Steps, timeoutsFrom } from "../core/state/steps.ts";
import { Store } from "../core/state/store.ts";
import type { Entry, Event } from "../core/state/trajectory.ts";

/** Remembers every call, and answers whatever the test lined up. */
class FakeChecker {
  readonly calls: { src: string; tgt: string; timeoutMs?: number }[] = [];
  constructor(private outcomes: CheckOutcome[]) {}

  async check(src: string, tgt: string, options?: { timeoutMs?: number }): Promise<CheckResult> {
    this.calls.push({ src, tgt, timeoutMs: options?.timeoutMs });
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

async function tree() {
  const src = await store.put(SRC);
  const tgt = await store.put(TGT);
  const events: Event[] = [{ kind: "run_start", src, tgt, config: {}, versions: {} }];
  return derive(events.map((event) => ({ ...event, time: 0, prev: "" }) as Entry));
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
    await steps.checkGoal(await tree(), "g1", 1000);
    expect(checker.calls[0]?.timeoutMs).toBe(1000);
    await steps.checkGoal(await tree(), "g1", DEFAULT_TIMEOUTS.checkCapMs * 10);
    expect(checker.calls[1]?.timeoutMs).toBe(DEFAULT_TIMEOUTS.checkCapMs);
  });
});
