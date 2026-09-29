// Cutting a goal in two.
//
// llops does the outlining for real, since a cut is exactly what it knows how
// to do; no solver is involved, because a cut is checked afterwards through
// its children. Skips when llops is not built.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Llops } from "../core/drivers/llops.ts";
import type { Goal } from "../core/state/goals.ts";
import { derive, head, type Tree } from "../core/state/goals.ts";
import { Splits } from "../core/state/splits.ts";
import { Store } from "../core/state/store.ts";
import type { Effect, Entry, Event } from "../core/state/trajectory.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

const PROGRAM = `define i32 @f(i32 %x, i32 %y) {
entry:
  %m = mul i32 %x, %y
  %s = add i32 %m, %x
  ret i32 %s
}
`;

let dir: string;
let store: Store;
let events: Event[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-split-"));
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

/** The goal an id names, so the tests need no null checks of their own. */
function goal(tree: Tree, id: string): Goal {
  const found = tree.goals.get(id);
  if (!found) throw new Error(`no goal ${id} in the derived tree`);
  return found;
}

/** The tree as the log so far describes it. */
function replay(): Tree {
  return derive(events.map((event) => ({ ...event, time: 0, prev: "" }) as Entry));
}

/** Record effects the way the tool wrapper will, then re-derive. */
function record(effects: Effect[]): Tree {
  events.push({ kind: "tool_result", id: "1", tool: "split", effects, result: null, ms: 1 });
  return replay();
}

// Its header is %bb1 in canonical form, and %1 its phi.
const LOOP = `define i32 @f(i32 %n) {
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

async function start(program = PROGRAM, other = program) {
  const src = await store.put(program);
  const tgt = await store.put(other);
  events.push({ kind: "start", src, tgt, config: {}, versions: {} });
  return replay();
}

describe.skipIf(!built)("splitting", () => {
  test("cuts both sides and opens two children", async () => {
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(), "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });

    if (result.kind !== "split") throw new Error(result.message);
    expect(result.children).toEqual({ outer: "g2", callee: "g3" });
    expect(result.callee).toBe("outlined_g3");
    expect(result.params.map((param) => param.live)).toEqual(["%2", "%0"]);

    const tree = record(result.effects);
    expect(tree.goals.get("g1")?.status).toBe("split");
    expect(tree.goals.get("g2")?.role).toBe("outer");
    expect(tree.goals.get("g3")?.role).toBe("callee");
  });

  test("the outer calls what the callee defines, under one name", async () => {
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(), "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (result.kind !== "split") throw new Error(result.message);

    const tree = record(result.effects);
    const outer = store.get(head(goal(tree, "g2"), "src"));
    const callee = store.get(head(goal(tree, "g3"), "src"));
    expect(outer).toContain(`call i32 @${result.callee}`);
    expect(outer).toContain(`declare i32 @${result.callee}`);
    expect(callee).toContain(`define i32 @${result.callee}`);
  });

  test("what it cut can be put back together", async () => {
    const splits = new Splits(store, llops);
    const tree0 = await start();
    const before = store.get(head(goal(tree0, "g1"), "src"));
    const result = await splits.split(tree0, "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (result.kind !== "split") throw new Error(result.message);

    const tree = record(result.effects);
    const back = await llops.inline(
      store.get(head(goal(tree, "g2"), "src")),
      store.get(head(goal(tree, "g3"), "src")),
      result.callee,
    );
    if (!back.ok) throw new Error(back.message);
    const canonical = await llops.canon(back.module);
    if (!canonical.ok) throw new Error(canonical.message);
    expect(canonical.module).toBe(before);
  });

  test("naming a block detaches it, and a loop's back edge calls the hypothesis", async () => {
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(LOOP), "g1", "%bb1", "%bb1", {
      "%1": "%1",
      "%0": "%0",
    });
    if (result.kind !== "split") throw new Error(result.message);
    expect(result.detach?.hypothesis).toBe("outlined_g3.ih");

    const tree = record(result.effects);
    expect(goal(tree, "g3").detach).toEqual({
      phis: { src: [0], tgt: [0] },
      hypothesis: "outlined_g3.ih",
    });
    expect(store.get(head(goal(tree, "g3"), "src"))).toContain("call i32 @outlined_g3.ih(");
  });

  test("cuts a body that branches at an instruction, taking the blocks after it", async () => {
    const branching = `define i32 @f(i32 %x) {
entry:
  %c = icmp slt i32 %x, 0
  br i1 %c, label %flip, label %join

flip:
  %m = sub i32 0, %x
  br label %join

join:
  %a = phi i32 [ %m, %flip ], [ %x, %entry ]
  ret i32 %a
}
`;
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(branching), "g1", "%1", "%1", { "%0": "%0" });
    if (result.kind !== "split") throw new Error(result.message);
    const tree = record(result.effects);
    expect(store.get(head(goal(tree, "g2"), "src"))).toContain("call i32 @outlined_g3(i32 %0)");
    expect(store.get(head(goal(tree, "g3"), "src"))).toContain("br i1");
    expect(goal(tree, "g3").detach).toBeUndefined();
  });

  test("refuses a block that heads a loop on one side only", async () => {
    const once = LOOP.replace(", [ %i.next, %loop ]", "").replace(
      "br i1 %c, label %loop, label %exit",
      "br label %exit",
    );
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(LOOP, once), "g1", "%bb1", "%bb1", {
      "%1": "%1",
      "%0": "%0",
    });
    expect(result).toMatchObject({ kind: "refused", code: "invalid" });
    if (result.kind === "refused") expect(result.message).toContain("one side only");
  });

  test("refuses a cut whose halves do not go back together as the side", async () => {
    // One tgt phi stands for two src phis, which detach takes and reattach
    // cannot undo: the tgt comes back with two phis.
    const twin = LOOP.replace(
      "  %i.next = add i32 %i, 1\n",
      "  %j = phi i32 [ 0, %entry ], [ %j.next, %loop ]\n  %i.next = add i32 %i, 1\n  %j.next = add i32 %j, 1\n",
    ).replace("  ret i32 %i\n", "  %r = add i32 %i, %j\n  ret i32 %r\n");
    const single = LOOP.replace("  ret i32 %i\n", "  %r = add i32 %i, %i\n  ret i32 %r\n");
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(twin, single), "g1", "%bb1", "%bb1", {
      "%1": "%1",
      "%2": "%1",
      "%0": "%0",
    });
    expect(result).toMatchObject({ kind: "refused", side: "tgt", code: "invalid" });
    if (result.kind === "refused") expect(result.message).toContain("another program");
  });

  test("reads a block off the program's labels", async () => {
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(LOOP), "g1", "%entry", "%entry", {});
    expect(result).toMatchObject({ kind: "refused", side: "src", code: "invalid" });
    if (result.kind === "refused") expect(result.message).toContain("entry block");
  });

  test("refuses a block on one side and a value on the other", async () => {
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(LOOP), "g1", "%bb1", "%2", { "%1": "%1" });
    expect(result).toMatchObject({ kind: "refused", code: "invalid" });
  });

  test("refuses a cut point that is not there, naming the side", async () => {
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(), "g1", "%nope", "%3", {});
    expect(result).toMatchObject({ kind: "refused", side: "src", code: "not_found" });
  });

  test("refuses a map that leaves a live value uncovered", async () => {
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(), "g1", "%3", "%3", { "%2": "%2" });
    // The cut points do not line up yet, which is the agent's signal to
    // rewrite a side before cutting.
    expect(result).toMatchObject({ kind: "refused", side: "tgt" });
  });

  test("stores nothing when a side refuses", async () => {
    const splits = new Splits(store, llops);
    const tree = await start();
    const before = store.hashes().length;
    await splits.split(tree, "g1", "%3", "%nope", { "%2": "%2", "%0": "%0" });
    expect(store.hashes()).toHaveLength(before);
  });

  test("refuses to cut a goal that is not open", async () => {
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(), "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (result.kind !== "split") throw new Error(result.message);
    const tree = record(result.effects);
    await expect(splits.split(tree, "g1", "%3", "%3", {})).rejects.toThrow(/g1 is split/);
  });
});

describe.skipIf(!built)("unsplitting", () => {
  test("discards the children and reopens the parent", async () => {
    const splits = new Splits(store, llops);
    const result = await splits.split(await start(), "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (result.kind !== "split") throw new Error(result.message);

    const tree = record(result.effects);
    const after = record(splits.unsplit(tree, "g1"));
    expect(after.goals.get("g1")?.status).toBe("open");
    expect(after.goals.has("g2")).toBe(false);
  });

  test("the next cut gets fresh names, not the discarded ones", async () => {
    const splits = new Splits(store, llops);
    let tree = await start();
    const first = await splits.split(tree, "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (first.kind !== "split") throw new Error(first.message);
    tree = record(first.effects);
    tree = record(splits.unsplit(tree, "g1"));

    const second = await splits.split(tree, "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (second.kind !== "split") throw new Error(second.message);
    // g2 and g3 were used once and are not handed out again, so a trajectory
    // names one goal one thing.
    expect(second.children).toEqual({ outer: "g4", callee: "g5" });
  });

  test("refuses a goal that was never cut", async () => {
    const splits = new Splits(store, llops);
    const tree = await start();
    expect(() => splits.unsplit(tree, "g1")).toThrow(/g1 is open, not split/);
  });
});
