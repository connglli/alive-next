// Cutting a goal in two.
//
// llops does the outlining for real, since a cut is exactly what it knows how
// to do; no solver is involved, because a cut is checked afterwards through
// its children. Skips when llops is not built.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Llops } from "../src/drivers/llops.ts";
import type { Goal } from "../src/state/goals.ts";
import { derive, head, type Tree } from "../src/state/goals.ts";
import { Splits } from "../src/state/splits.ts";
import { Store } from "../src/state/store.ts";
import type { Effect, Entry, Event } from "../src/state/trajectory.ts";
import { llopsBinary } from "./binaries.ts";

const llops = new Llops(llopsBinary());
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

async function start() {
  const src = await store.put(PROGRAM);
  const tgt = await store.put(PROGRAM);
  events.push({ kind: "run_start", src, tgt, config: {}, versions: {} });
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
