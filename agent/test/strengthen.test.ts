// Strengthening a cut's interface.
//
// The programs are the worked example from the design: a mask in the prefix
// and a narrowed multiply in the suffix, so the callee goal is false until the
// range comes back. llops is real, since the assume and the attributes are
// real IR; the checker is a stand-in, so what is under test is which records
// are made and of what kind.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../src/config.ts";
import type { CheckOutcome, CheckResult } from "../src/drivers/alive2.ts";
import { Llops } from "../src/drivers/llops.ts";
import type { Goal, Tree } from "../src/state/goals.ts";
import { applyEffect, derive, head } from "../src/state/goals.ts";
import { Splits } from "../src/state/splits.ts";
import { Steps } from "../src/state/steps.ts";
import { Store } from "../src/state/store.ts";
import { Strengthen } from "../src/state/strengthen.ts";
import type { Effect, Entry, Event } from "../src/state/trajectory.ts";

class FakeChecker {
  readonly calls: { src: string; tgt: string }[] = [];
  constructor(private outcomes: CheckOutcome[]) {}
  async check(src: string, tgt: string): Promise<CheckResult> {
    this.calls.push({ src, tgt });
    const outcome = this.outcomes.shift() ?? "unknown";
    return {
      outcome,
      detail: outcome === "incorrect" ? "ERROR: Value mismatch" : "",
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 0 },
      stdout: "",
      ms: 1,
    };
  }
}

const llops = new Llops(process.env.LLOPS ?? join(repoRoot(), "build", "llops", "llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

const SRC = `define i32 @f(i32 %n) {
entry:
  %m = and i32 %n, 255
  %s = mul i32 %m, 2
  ret i32 %s
}
`;
const TGT = `define i32 @f(i32 %n) {
entry:
  %m = and i32 %n, 255
  %t = trunc i32 %m to i16
  %p = mul i16 %t, 2
  %s = zext i16 %p to i32
  ret i32 %s
}
`;
const RANGE = { range: { min: 0, max: 256 } };

let dir: string;
let store: Store;
let events: Event[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-str-"));
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

function goal(tree: Tree, id: string): Goal {
  const found = tree.goals.get(id);
  if (!found) throw new Error(`no goal ${id}`);
  return found;
}

function replay(): Tree {
  return derive(events.map((event) => ({ ...event, time: 0, prev: "" }) as Entry));
}

function record(effects: Effect[]): Tree {
  for (const effect of effects) {
    events.push({ kind: "tool_result", id: "1", tool: "split", effect, result: null, ms: 1 });
  }
  return replay();
}

/** A goal cut at the multiply, which is where the range is lost. */
async function cut(): Promise<Tree> {
  const src = await store.put(SRC);
  const tgt = await store.put(TGT);
  events.push({ kind: "run_start", src, tgt, config: {}, versions: {} });
  const result = await new Splits(store, llops).split(replay(), "g1", "%2", "%2", { "%1": "%1" });
  if (result.kind !== "split") throw new Error(result.message);
  return record(result.effects);
}

describe.skipIf(!built)("strengthening", () => {
  test("proves the fact, then attributes it in four programs", async () => {
    const checker = new FakeChecker(["correct", "correct", "correct", "unknown", "unknown"]);
    const tree = await cut();
    const strengthen = new Strengthen(store, llops, new Steps(store, checker));
    const result = await strengthen.strengthen(tree, "g1", 0, RANGE);

    if (result.kind !== "strengthened") throw new Error(result.reason);
    // Three certified steps and one claim: the assume, the outer's two
    // declarations, and the callee's pair.
    expect(result.effects.map((effect) => effect.effect)).toEqual([
      "step",
      "step",
      "step",
      "strengthen",
    ]);

    const outerSrc = store.get(head(goal(tree, "g2"), "src"));
    expect(outerSrc).toContain("call void @llvm.assume");
    expect(outerSrc).toContain("declare i32 @outlined_g3(i32 range(i32 0, 256))");
    expect(store.get(head(goal(tree, "g2"), "tgt"))).toContain("range(i32 0, 256)");
    expect(store.get(head(goal(tree, "g3"), "src"))).toContain(
      "define i32 @outlined_g3(i32 range(i32 0, 256)",
    );
    expect(store.get(head(goal(tree, "g3"), "tgt"))).toContain("range(i32 0, 256)");
  });

  test("the callee's two sides move together, justified by the assume", async () => {
    const checker = new FakeChecker(["correct", "correct", "correct", "unknown", "unknown"]);
    const tree = await cut();
    const result = await new Strengthen(store, llops, new Steps(store, checker)).strengthen(
      tree,
      "g1",
      0,
      RANGE,
    );
    if (result.kind !== "strengthened") throw new Error(result.reason);

    const last = result.effects[3];
    if (last?.effect !== "strengthen") throw new Error("expected a strengthen effect");
    expect(last.gid).toBe("g3");
    // It names the step that makes it sound, which is what a replay re-checks.
    expect(last.by.gid).toBe("g2");
    expect(last.by.hash).toBe((result.effects[0] as { to: string }).to);
  });

  test("checks both goals once at the end", async () => {
    // Three steps, then one cross-check each: no solver is asked about the
    // state between the outer's two sides being attributed.
    const checker = new FakeChecker(["correct", "correct", "correct", "correct", "correct"]);
    const tree = await cut();
    const result = await new Strengthen(store, llops, new Steps(store, checker)).strengthen(
      tree,
      "g1",
      0,
      RANGE,
    );
    if (result.kind !== "strengthened") throw new Error(result.reason);

    expect(checker.calls).toHaveLength(5);
    // The fourth call is the callee's own pair, both sides now attributed.
    expect(checker.calls[3]?.src).toContain("define i32 @outlined_g3(i32 range(i32 0, 256)");
    expect(checker.calls[3]?.tgt).toContain("range(i32 0, 256)");
    // Both discharge, and that carries the parent with them.
    expect(goal(tree, "g3").status).toBe("proved");
    expect(goal(tree, "g2").status).toBe("proved");
    expect(goal(tree, "g1").status).toBe("proved");
  });

  test("a second fact can be added after the first discharged the outer", async () => {
    // The callee needs two facts, so its first cross-check settles nothing
    // while the outer's discharges it. The second round reopens the outer,
    // because that proof was about the pair the new assume replaces.
    const checker = new FakeChecker([
      "correct",
      "correct",
      "correct",
      "unknown",
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
    ]);
    const strengthen = new Strengthen(store, llops, new Steps(store, checker));
    const tree = await cut();

    const first = await strengthen.strengthen(tree, "g1", 0, RANGE);
    expect(first.kind).toBe("strengthened");
    expect(goal(tree, "g2").status).toBe("proved");

    const second = await strengthen.strengthen(tree, "g1", 0, { noundef: true });
    expect(second.kind).toBe("strengthened");
    expect(store.get(head(goal(tree, "g3"), "src"))).toContain("noundef");
    expect(goal(tree, "g1").status).toBe("proved");
  });

  test("refuses a child that has been cut further", async () => {
    const tree = await cut();
    const inner = await new Splits(store, llops).split(tree, "g3", "%1", "%1", { "%0": "%0" });
    if (inner.kind !== "split") throw new Error(inner.message);
    for (const effect of inner.effects) applyEffect(tree, effect);

    const result = await new Strengthen(
      store,
      llops,
      new Steps(store, new FakeChecker([])),
    ).strengthen(tree, "g1", 0, RANGE);
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("g3 is split");
  });

  test("the assume is what goes to alive2 first, in the src direction", async () => {
    const checker = new FakeChecker(["correct", "correct", "correct", "unknown", "unknown"]);
    const tree = await cut();
    const before = store.get(head(goal(tree, "g2"), "src"));
    await new Strengthen(store, llops, new Steps(store, checker)).strengthen(tree, "g1", 0, RANGE);

    expect(checker.calls[0]?.src).toBe(before);
    expect(checker.calls[0]?.tgt).toContain("llvm.assume");
  });

  test("stops at phase one when the fact does not hold", async () => {
    // alive2 refuses the assume, which is what a false fact looks like.
    const checker = new FakeChecker(["incorrect"]);
    const tree = await cut();
    const before = head(goal(tree, "g2"), "src");
    const result = await new Strengthen(store, llops, new Steps(store, checker)).strengthen(
      tree,
      "g1",
      0,
      RANGE,
    );

    expect(result).toMatchObject({ kind: "refused", phase: "assume" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.effects).toEqual([]);
    expect(head(goal(tree, "g2"), "src")).toBe(before);
    // Nothing reached the callee.
    expect(store.get(head(goal(tree, "g3"), "src"))).not.toContain("range");
  });

  test("says what landed when phase two gives up partway", async () => {
    // The assume is certified; the attribute on the outer tgt is not.
    const checker = new FakeChecker(["correct", "correct", "incorrect"]);
    const tree = await cut();
    const result = await new Strengthen(store, llops, new Steps(store, checker)).strengthen(
      tree,
      "g1",
      0,
      RANGE,
    );

    expect(result).toMatchObject({ kind: "refused", phase: "attribute" });
    if (result.kind !== "refused") throw new Error("unreachable");
    // Two steps stand, and the head shows them: the agent reverts what it
    // does not want rather than being told nothing happened.
    expect(result.effects).toHaveLength(2);
    expect(store.get(head(goal(tree, "g2"), "src"))).toContain("llvm.assume");
    expect(store.get(head(goal(tree, "g3"), "src"))).not.toContain("range");
  });

  test("refuses a fact llops will not state", async () => {
    const tree = await cut();
    const result = await new Strengthen(
      store,
      llops,
      new Steps(store, new FakeChecker([])),
    ).strengthen(tree, "g1", 0, { noalias: true });
    expect(result).toMatchObject({ kind: "refused", phase: "assume" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("noalias");
  });

  test("needs a goal that was cut", async () => {
    const src = await store.put(SRC);
    const tgt = await store.put(TGT);
    events.push({ kind: "run_start", src, tgt, config: {}, versions: {} });
    const strengthen = new Strengthen(store, llops, new Steps(store, new FakeChecker([])));
    await expect(strengthen.strengthen(replay(), "g1", 0, RANGE)).rejects.toThrow(
      /g1 is open, not split/,
    );
  });
});
