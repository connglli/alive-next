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
import type { CheckOutcome, CheckResult } from "../core/drivers/alive2.ts";
import { type Attrs, Llops, type Predicate } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import type { Goal, Tree } from "../core/state/goals.ts";
import { applyEffect, derive, head } from "../core/state/goals.ts";
import { Splits } from "../core/state/splits.ts";
import { DEFAULT_TIMEOUTS, Steps } from "../core/state/steps.ts";
import { Store } from "../core/state/store.ts";
import { explainAssumeRefusal, Strengthen } from "../core/state/strengthen.ts";
import type { Effect, Entry, Event } from "../core/state/trajectory.ts";
import { toolchain } from "./toolchain-under-test.ts";

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

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

/** A stand-in for llrwt that refuses any use, for tests that never rewrite. */
const unrewriting = {
  apply: async () => ({
    ok: false as const,
    code: "unavailable",
    message: "unused in this test",
  }),
} as unknown as Llrwt;

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
const WIDE_SRC = SRC.replace("  ret i32 %s", "  %r = xor i32 %s, %n\n  ret i32 %r");
const WIDE_TGT = TGT.replace("  ret i32 %s", "  %r = xor i32 %s, %n\n  ret i32 %r");
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
  events.push({ kind: "tool_result", id: "1", tool: "split", effects, result: null, ms: 1 });
  return replay();
}

/** A goal cut at the multiply, which is where the range is lost. */
async function cut(): Promise<Tree> {
  return cutting(SRC, TGT, { "%1": "%1" });
}

/** The same, with the parameter live past the cut, so two values cross it. */
async function cutTwice(): Promise<Tree> {
  return cutting(WIDE_SRC, WIDE_TGT, { "%1": "%1", "%0": "%0" });
}

async function cutting(srcText: string, tgtText: string, map: Record<string, string>) {
  const src = await store.put(srcText);
  const tgt = await store.put(tgtText);
  events.push({ kind: "start", src, tgt, config: {}, versions: {} });
  const result = await new Splits(store, llops).split(replay(), "g1", "%2", "%2", map);
  if (result.kind !== "split") throw new Error(result.message);
  return record(result.effects);
}

// Its header is %bb1 in canonical form: i is %1, the bound %0, so the callee
// is k(i, n) and a contract such as i <=u n compares parameters 0 and 1.
const LOOP = `define i32 @f(i32 noundef %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %i.next = add i32 %i, 1
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit

exit:
  ret i32 %i
}
`;
const WITHIN = [{ insts: ["%le = icmp ule i32 !0, !1"] }];

/** The loop detached at its header, so the callee calls its hypothesis. */
async function detached(): Promise<Tree> {
  const src = await store.put(LOOP);
  events.push({ kind: "start", src, tgt: src, config: {}, versions: {} });
  const map = { "%1": "%1", "%0": "%0" };
  const result = await new Splits(store, llops).split(replay(), "g1", "%bb1", "%bb1", map);
  if (result.kind !== "split") throw new Error(result.message);
  return record(result.effects);
}

/** The loop with a counter only the tgt has, cut so that the src passes poison for it. */
async function ghosted(): Promise<Tree> {
  const src = await store.put(LOOP);
  const tgt = await store.put(
    LOOP.replace(
      "  %i.next = add i32 %i, 1\n",
      "  %k = phi i32 [ %n, %entry ], [ %k.next, %loop ]\n  %i.next = add i32 %i, 1\n  %k.next = add i32 %k, -1\n",
    ),
  );
  events.push({ kind: "start", src, tgt, config: {}, versions: {} });
  const map = { "%1": "%1", "%0": "%0", k: "%2" };
  const result = await new Splits(store, llops).split(replay(), "g1", "%bb1", "%bb1", map);
  if (result.kind !== "split") throw new Error(result.message);
  return record(result.effects);
}
const ABOUT_THE_COUNTER = [{ op: "ule" as const, lhs: "!2", rhs: "!1" }];

/** The tree once the effects a move returned are in the log. */
function replayWith(effects: Effect[]): Tree {
  events.push({ kind: "tool_result", id: "2", tool: "strengthen", effects, result: null, ms: 1 });
  return replay();
}

function strengthening(checker: FakeChecker): Strengthen {
  return new Strengthen(
    store,
    llops,
    new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
  );
}

describe.skipIf(!built)("strengthening a loop", () => {
  test("a callee that calls its hypothesis takes no function attributes", async () => {
    const checker = new FakeChecker([]);
    const tree = await detached();
    const result = await strengthening(checker).strengthen(tree, "g1", {
      fn_attrs: { nounwind: true },
    });
    expect(result).toMatchObject({ kind: "refused", phase: "callee_attr", effects: [] });
    expect(checker.calls).toHaveLength(0);
  });

  test("a contract one iteration does not keep lands nothing", async () => {
    const checker = new FakeChecker(["incorrect"]);
    const tree = await detached();
    const result = await strengthening(checker).strengthen(tree, "g1", { predicates: WITHIN });
    expect(result).toMatchObject({ kind: "refused", phase: "hypothesis", effects: [] });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.explanation).toContain("Source and Target are both the callee's src");
    expect(result.check?.detail).toContain("ERROR: Value mismatch");
    // The one question asked is the iteration's, before the outer's.
    expect(checker.calls).toHaveLength(1);
    expect(checker.calls[0]?.tgt).toContain("@outlined_g3.ih(");
  });

  test("names the hypothesis call that passes poison for a parameter the facts name", async () => {
    const result = await strengthening(new FakeChecker(["incorrect"])).strengthen(
      await ghosted(),
      "g1",
      { predicates: ABOUT_THE_COUNTER },
    );
    if (result.kind !== "refused") throw new Error("expected a refusal");
    expect(result.phase).toBe("hypothesis");
    expect(result.explanation).toMatch(
      /^At #\d+ the src still passes poison for parameter 2 of @outlined_g3\.ih, so no fact about it can hold there\./,
    );
  });

  test("names the outer's call that passes poison for a parameter the facts name", async () => {
    const result = await strengthening(new FakeChecker(["correct", "incorrect"])).strengthen(
      await ghosted(),
      "g1",
      { predicates: ABOUT_THE_COUNTER },
    );
    if (result.kind !== "refused") throw new Error("expected a refusal");
    expect(result.phase).toBe("assume");
    expect(result.explanation).toMatch(
      /^At #\d+ the src still passes poison for parameter 2 of @outlined_g3,/,
    );
  });

  test("a contract is proved before both calls, the loop's in the callee's chain", async () => {
    // The iteration's question, the outer's, then the two goals' checks: the
    // iteration's step lands on its own answer rather than a second one.
    const checker = new FakeChecker(["correct", "correct", "unknown", "unknown"]);
    const tree = await detached();
    const result = await strengthening(checker).strengthen(tree, "g1", { predicates: WITHIN });
    if (result.kind !== "strengthened") throw new Error(result.reason);

    const claim = result.effects.find((effect) => effect.effect === "strengthen");
    if (claim?.effect !== "strengthen") throw new Error("expected a strengthen effect");
    expect(claim.by?.map((proof) => proof.gid)).toEqual(["g2", "g3"]);
    const kept = result.effects.find((effect) => effect.effect === "step" && effect.gid === "g3");
    expect(kept).toMatchObject({ side: "src", to: claim.by?.[1]?.hash });
  });

  test("parameter facts go on the hypothesis too, on both sides", async () => {
    // The iteration's question, the outer's, its two declarations, the
    // hypothesis's two declarations, then the two goals' checks.
    const checker = new FakeChecker([
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
    ]);
    const tree = await detached();
    const result = await strengthening(checker).strengthen(tree, "g1", {
      param_attrs: { 0: { noundef: true }, 1: { noundef: true } },
    });
    if (result.kind !== "strengthened") throw new Error(result.reason);

    const after = replayWith(result.effects);
    for (const side of ["src", "tgt"] as const) {
      const text = store.get(head(goal(after, "g3"), side));
      expect(text).toContain("declare i32 @outlined_g3.ih(i32 noundef, i32 noundef)");
      expect(text).toContain("define i32 @outlined_g3(i32 noundef %0, i32 noundef %1)");
    }
  });
});

describe.skipIf(!built)("strengthening", () => {
  test("proves the fact, then attributes it in four programs", async () => {
    const checker = new FakeChecker(["correct", "correct", "correct", "unknown", "unknown"]);
    const tree = await cut();
    const strengthen = new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    );
    const result = await strengthen.strengthen(tree, "g1", { param_attrs: { 0: RANGE } });

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
    const result = await new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    ).strengthen(tree, "g1", { param_attrs: { 0: RANGE } });
    if (result.kind !== "strengthened") throw new Error(result.reason);

    const last = result.effects[3];
    if (last?.effect !== "strengthen") throw new Error("expected a strengthen effect");
    expect(last.gid).toBe("g3");
    // It names the step that makes it sound, which is what a replay re-checks.
    expect(last.by).toEqual([{ gid: "g2", hash: (result.effects[0] as { to: string }).to }]);
  });

  test("checks both goals once at the end", async () => {
    // Three steps, then one cross-check each: no solver is asked about the
    // state between the outer's two sides being attributed.
    const checker = new FakeChecker(["correct", "correct", "correct", "correct", "correct"]);
    const tree = await cut();
    const result = await new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    ).strengthen(tree, "g1", { param_attrs: { 0: RANGE } });
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

  test("several parameters cost what one does", async () => {
    // An interface is one thing, so the assumes are proved together and the
    // attributes land together: three steps and two cross-checks, as for one.
    const checker = new FakeChecker(["correct", "correct", "correct", "unknown", "unknown"]);
    const tree = await cutTwice();
    const result = await new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    ).strengthen(tree, "g1", { param_attrs: { 0: RANGE, 1: { noundef: true } } });
    if (result.kind !== "strengthened") throw new Error(result.reason);

    expect(checker.calls).toHaveLength(5);
    const calleeSrc = store.get(head(goal(tree, "g3"), "src"));
    expect(calleeSrc).toContain("range(i32 0, 256)");
    expect(calleeSrc).toContain("noundef");
    // Both assumes went to alive2 in the one step that certifies the pair.
    expect(checker.calls[0]?.tgt.match(/call void @llvm\.assume/g)).toHaveLength(2);
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
    const strengthen = new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    );
    const tree = await cut();

    const first = await strengthen.strengthen(tree, "g1", { param_attrs: { 0: RANGE } });
    expect(first.kind).toBe("strengthened");
    expect(goal(tree, "g2").status).toBe("proved");

    const second = await strengthen.strengthen(tree, "g1", {
      param_attrs: { 0: { noundef: true } },
    });
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
      new Steps(store, new FakeChecker([]), DEFAULT_TIMEOUTS, llops, unrewriting),
    ).strengthen(tree, "g1", { param_attrs: { 0: RANGE } });
    expect(result).toMatchObject({ kind: "refused" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("g3 is split");
  });

  test("the assume is what goes to alive2 first, in the src direction", async () => {
    const checker = new FakeChecker(["correct", "correct", "correct", "unknown", "unknown"]);
    const tree = await cut();
    const before = store.get(head(goal(tree, "g2"), "src"));
    await new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    ).strengthen(tree, "g1", {
      param_attrs: { 0: RANGE },
    });

    expect(checker.calls[0]?.src).toBe(before);
    expect(checker.calls[0]?.tgt).toContain("llvm.assume");
  });

  test("stops at phase one when the fact does not hold", async () => {
    // alive2 refuses the assume, which is what a false fact looks like.
    const checker = new FakeChecker(["incorrect"]);
    const tree = await cut();
    const before = head(goal(tree, "g2"), "src");
    const result = await new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    ).strengthen(tree, "g1", { param_attrs: { 0: RANGE } });

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
    const result = await new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    ).strengthen(tree, "g1", { param_attrs: { 0: RANGE } });

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
      new Steps(store, new FakeChecker([]), DEFAULT_TIMEOUTS, llops, unrewriting),
    ).strengthen(tree, "g1", { param_attrs: { 0: { noalias: true } } });
    expect(result).toMatchObject({ kind: "refused", phase: "assume" });
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toContain("noalias");
  });

  test("needs a goal that was cut", async () => {
    const src = await store.put(SRC);
    const tgt = await store.put(TGT);
    events.push({ kind: "start", src, tgt, config: {}, versions: {} });
    const strengthen = new Strengthen(
      store,
      llops,
      new Steps(store, new FakeChecker([]), DEFAULT_TIMEOUTS, llops, unrewriting),
    );
    await expect(
      strengthen.strengthen(replay(), "g1", { param_attrs: { 0: RANGE } }),
    ).rejects.toThrow(/g1 is open, not split/);
  });

  test("names the goal that cut a child it is given", async () => {
    const tree = await cut();
    await expect(
      strengthening(new FakeChecker([])).strengthen(tree, "g3", { param_attrs: { 0: RANGE } }),
    ).rejects.toThrow(/g3 is open, not split; strengthen g1, which cut it/);
  });

  test("facts are keyed by parameter position", async () => {
    const tree = await cut();
    const strengthen = new Strengthen(
      store,
      llops,
      new Steps(store, new FakeChecker([]), DEFAULT_TIMEOUTS, llops, unrewriting),
    );
    for (const bad of ["%0", "-1", "1.5", "0x1"]) {
      await expect(
        strengthen.strengthen(tree, "g1", {
          param_attrs: { [bad]: { noundef: true } } as unknown as Record<number, Attrs>,
        }),
      ).rejects.toThrow(new RegExp(`by parameter index, 0, 1, ..., not '${bad}'`));
    }
    expect(tree.goals.get("g1")?.status).toBe("split");
  });

  test("a contract that names a value is refused before anything lands", async () => {
    // At the callee's start only its arguments are in scope, so a contract
    // naming anything else could mean one thing there and another at a call.
    const tree = await cut();
    const checker = new FakeChecker([]);
    const strengthen = new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    );
    const named: Predicate = { insts: ["%nz = icmp ne i32 %0, 0"] };
    const result = await strengthen.strengthen(tree, "g1", { predicates: [named] });
    expect(result).toMatchObject({ kind: "refused", effects: [] });
    expect(checker.calls).toHaveLength(0);
  });

  test("explainAssumeRefusal produces clear diagnostic on noundef poison failure", () => {
    const detail = `ERROR: Source is more defined than target

Example:
i32 %1 = poison

Source:
...
Target:
...
`;
    const check: CheckResult = {
      outcome: "incorrect",
      detail,
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 1000 },
      stdout: "",
      ms: 10,
    };
    const explanation = explainAssumeRefusal([1], { 1: { noundef: true } }, check, "g2");
    expect(explanation).toContain("The outer's example input: i32 %1 = poison");
    expect(explanation).toContain("a parameter is poison, and no fact holds for a poison value");
    expect(explanation).toContain('goal_analyze on g2 with kind "defined"');
  });

  test("explainAssumeRefusal names the range analysis for a failed range fact", () => {
    const check: CheckResult = {
      outcome: "incorrect",
      detail: "ERROR: Value mismatch\n\nExample:\ni32 %0 = 300\n",
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 1000 },
      stdout: "",
      ms: 10,
    };
    const explanation = explainAssumeRefusal(
      [0],
      { 0: { range: { min: 0, max: 256 } } },
      check,
      "g2",
      1,
    );
    expect(explanation).toContain('goal_analyze on g2 with kind "ranges" and point "#1"');
  });

  test("explainAssumeRefusal sends pointer facts to the pointer analysis", () => {
    const check: CheckResult = {
      outcome: "incorrect",
      detail: "ERROR: Value mismatch\n\nExample:\nptr %0 = null\n",
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 1000 },
      stdout: "",
      ms: 10,
    };
    const explanation = explainAssumeRefusal([0], { 0: { nonnull: true } }, check, "g2");
    expect(explanation).toContain('goal_analyze on g2 with kind "pointer"');
  });

  test("explainAssumeRefusal reads the arrow style alive2 sometimes prints", () => {
    const detail = `ERROR: Source is more defined than target

Example:
i32 %0 -> 0
i32 %1 -> poison
`;
    const check: CheckResult = {
      outcome: "incorrect",
      detail,
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 1000 },
      stdout: "",
      ms: 10,
    };
    const explanation = explainAssumeRefusal(
      [0, 1],
      { 0: { noundef: true }, 1: { noundef: true } },
      check,
      "g2",
    );
    expect(explanation).toContain("The outer's example input: i32 %0 -> 0, i32 %1 -> poison");
    expect(explanation).toContain("a parameter is poison, and no fact holds for a poison value");
  });

  test("explainAssumeRefusal reads a value that contains its own '='", () => {
    const detail = `ERROR: Source is more defined than target

Example:
ptr %p = pointer(non-local, block_id=1, offset=0) / Address=#x04
`;
    const check: CheckResult = {
      outcome: "incorrect",
      detail,
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 1000 },
      stdout: "",
      ms: 10,
    };
    const explanation = explainAssumeRefusal([0], { 0: { noundef: true } }, check, "g2");
    expect(explanation).toContain(
      "The outer's example input: ptr %p = pointer(non-local, block_id=1, offset=0) / Address=#x04",
    );
    expect(explanation).not.toContain(
      "a parameter is poison, and no fact holds for a poison value",
    );
  });

  test("explainAssumeRefusal shows the whole example when several were asked", () => {
    const detail = `ERROR: Source is more defined than target

Example:
i32 %0 = 1
i32 %1 = poison

Source:
...
Target:
...
`;
    const check: CheckResult = {
      outcome: "incorrect",
      detail,
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 1000 },
      stdout: "",
      ms: 10,
    };
    const explanation = explainAssumeRefusal(
      [0, 1],
      { 0: { noundef: true }, 1: { noundef: true } },
      check,
      "g2",
    );
    expect(explanation).toContain("The outer's example input: i32 %0 = 1, i32 %1 = poison");
    expect(explanation).toContain("a parameter is poison, and no fact holds for a poison value");
  });

  test("explainAssumeRefusal tells a killed check from one the solver gave up on", () => {
    const killed: CheckResult = {
      outcome: "unknown",
      detail: "killed after 150000ms without an answer",
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 120000 },
      stdout: "",
      ms: 150001,
    };
    expect(explainAssumeRefusal([0], { 0: { noundef: true } }, killed)).toContain(
      "alive2 ran out of time.",
    );

    const gaveUp: CheckResult = {
      outcome: "unknown",
      detail: "failed-to-prove transformations: 1",
      invocation: { binary: "alive-tv", flags: [], timeoutMs: 120000 },
      stdout: "",
      ms: 900,
    };
    expect(explainAssumeRefusal([0], { 0: { noundef: true } }, gaveUp)).toContain(
      "alive2 could not settle whether they hold.",
    );
  });

  test("strengthens with function attributes and certifies callee", async () => {
    // 2 callee attr checks (src, tgt), 2 outer steps (src, tgt), 2 cross checks
    const checker = new FakeChecker([
      "correct",
      "correct",
      "correct",
      "correct",
      "unknown",
      "unknown",
    ]);
    const tree = await cut();
    const strengthen = new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    );
    const result = await strengthen.strengthen(tree, "g1", {
      fn_attrs: { memory: "none", nounwind: true },
    });

    if (result.kind !== "strengthened") throw new Error(result.reason);
    const outerSrc = store.get(head(goal(tree, "g2"), "src"));
    expect(outerSrc).toContain("declare i32 @outlined_g3(i32) #0");
    expect(outerSrc).toContain("memory(none)");
    expect(outerSrc).toContain("nounwind");

    const calleeTgt = store.get(head(goal(tree, "g3"), "tgt"));
    expect(calleeTgt).toContain("memory(none)");
    expect(calleeTgt).toContain("nounwind");
  });

  test("strengthens with relational predicates across cut arguments", async () => {
    // 1 caller assume step, 2 cross checks
    const checker = new FakeChecker(["correct", "unknown", "unknown"]);
    const tree = await cutTwice();
    const strengthen = new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    );
    const result = await strengthen.strengthen(tree, "g1", {
      predicates: [{ insts: ["%lt = icmp slt i32 !0, !1"] }],
    });

    if (result.kind !== "strengthened") throw new Error(result.reason);
    const outerSrc = store.get(head(goal(tree, "g2"), "src"));
    expect(outerSrc).toContain("icmp slt");
    expect(outerSrc).toContain("call void @llvm.assume");

    const calleeSrc = store.get(head(goal(tree, "g3"), "src"));
    expect(calleeSrc).toContain("icmp slt");
    expect(calleeSrc).toContain("call void @llvm.assume");
  });

  test("strengthens with param_attrs, fn_attrs, and predicates combined", async () => {
    // 1 caller assume step, 2 callee attr checks (src, tgt), 2 outer attribute steps, 2 cross checks
    const checker = new FakeChecker([
      "correct",
      "correct",
      "correct",
      "correct",
      "correct",
      "unknown",
      "unknown",
    ]);
    const tree = await cutTwice();
    const strengthen = new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    );
    const result = await strengthen.strengthen(tree, "g1", {
      param_attrs: { 0: { noundef: true } },
      fn_attrs: { nounwind: true },
      predicates: [{ insts: ["%lt = icmp slt i32 !0, !1"] }],
    });

    if (result.kind !== "strengthened") throw new Error(result.reason);
    const outerSrc = store.get(head(goal(tree, "g2"), "src"));
    expect(outerSrc).toContain('"noundef"');
    expect(outerSrc).toContain("icmp slt");
    expect(outerSrc).toContain("nounwind");

    const calleeSrc = store.get(head(goal(tree, "g3"), "src"));
    expect(calleeSrc).toContain("noundef");
    expect(calleeSrc).toContain("nounwind");
    expect(calleeSrc).toContain("icmp slt");
  });

  test("refuses when callee function attribute check fails", async () => {
    const checker = new FakeChecker(["incorrect"]);
    const tree = await cut();
    const strengthen = new Strengthen(
      store,
      llops,
      new Steps(store, checker, DEFAULT_TIMEOUTS, llops, unrewriting),
    );
    const result = await strengthen.strengthen(tree, "g1", {
      fn_attrs: { memory: "none" },
    });

    expect(result.kind).toBe("refused");
    if (result.kind === "refused") {
      expect(result.phase).toBe("callee_attr");
    }
  });
});
