// Proving a goal by cases on a comparison of its parameters.
//
// llops builds both cases, as it would for a run; no solver is involved,
// because the two goals a split by cases leaves are proved afterwards. Skips
// when llops is not built.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Llops } from "../core/drivers/llops.ts";
import { cases, uncase } from "../core/state/cases.ts";
import { Cuts } from "../core/state/cuts.ts";
import { derive, type Goal, head, type Tree } from "../core/state/goals.ts";
import { Store } from "../core/state/store.ts";
import type { Effect, Entry, Event } from "../core/state/trajectory.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

const SRC = `define i32 @f(i32 noundef %x, i32 %y) {
entry:
  %m = mul i32 %x, 2
  %s = add i32 %m, %y
  ret i32 %s
}
`;
const TGT = SRC.replace("mul i32 %x, 2", "shl i32 %x, 1");
const BELOW_ZERO = { op: "slt", lhs: "!0", rhs: 0 } as const;

let dir: string;
let store: Store;
let events: Event[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-cases-"));
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

/** The tree once the start and the effects recorded so far are replayed. */
function replay(...effects: Effect[]): Tree {
  if (effects.length > 0)
    events.push({ kind: "tool_result", id: "1", tool: "", effects, result: null, ms: 1 });
  return derive(events.map((event) => ({ ...event, time: 0, prev: "" }) as Entry));
}

function goal(tree: Tree, id: string): Goal {
  const found = tree.goals.get(id);
  if (!found) throw new Error(`no goal ${id} in the derived tree`);
  return found;
}

async function start(src = SRC, tgt = TGT): Promise<Tree> {
  events.push({
    kind: "start",
    src: await store.put(src),
    tgt: await store.put(tgt),
    config: {},
    versions: {},
  });
  return replay();
}

describe.skipIf(!built)("cutting by cases", () => {
  test("leaves the case where the comparison holds and the case where it fails", async () => {
    const result = await cases(store, llops, await start(), "g1", BELOW_ZERO);
    if (result.kind !== "cased") throw new Error(result.message);
    expect(result.children).toEqual({ holds: "g2", fails: "g3" });

    const tree = replay(...result.effects);
    expect(goal(tree, "g1").status).toBe("split");
    expect([goal(tree, "g2").role, goal(tree, "g3").role]).toEqual(["holds", "fails"]);
    // Both programs of a case assume the same comparison at their start.
    for (const [gid, line] of [
      ["g2", "icmp slt i32 %0, 0"],
      ["g3", "icmp sge i32 %0, 0"],
    ] as const)
      for (const side of ["src", "tgt"] as const)
        expect(store.get(head(goal(tree, gid), side))).toContain(line);
  });

  test("refuses a comparison of a parameter that may be poison, which would lie in no case", async () => {
    const result = await cases(store, llops, await start(), "g1", { op: "eq", lhs: "!1", rhs: 0 });
    expect(result.kind === "refused" && result.message).toContain("!1 may be poison in the src");
  });

  test("splits a parameter that may be poison into the case it is not and the case it is", async () => {
    const result = await cases(store, llops, await start(), "g1", { defined: "!1" });
    if (result.kind !== "cased") throw new Error(result.message);
    const tree = replay(...result.effects);
    for (const side of ["src", "tgt"] as const) {
      expect(store.get(head(goal(tree, "g2"), side))).toContain("i32 noundef %1");
      expect(store.get(head(goal(tree, "g3"), side))).toContain(", poison");
    }
    // Where it is not poison, a comparison of it may cut the goal again.
    const again = await cases(store, llops, tree, "g2", { op: "eq", lhs: "!1", rhs: 0 });
    expect(again.kind).toBe("cased");
  });

  test("refuses to split a vector on its poison, which may be poison in part", async () => {
    const lanes = `define <2 x i32> @f(<2 x i32> %v) {
entry:
  ret <2 x i32> %v
}
`;
    const result = await cases(store, llops, await start(lanes, lanes), "g1", { defined: "!0" });
    expect(result.kind === "refused" && result.message).toContain("may be poison in part");
  });

  test("refuses a comparison of anything but parameters and integers", async () => {
    const tree = await start();
    for (const predicate of [
      { op: "eq", lhs: 1, rhs: 0 },
      { op: "eq", lhs: "%x", rhs: 0 },
      { op: "eq", lhs: "!2", rhs: 0 },
    ] as const) {
      const result = await cases(store, llops, tree, "g1", predicate);
      expect(result.kind).toBe("refused");
    }
  });

  test("is undone by uncase", async () => {
    const result = await cases(store, llops, await start(), "g1", BELOW_ZERO);
    if (result.kind !== "cased") throw new Error(result.message);
    const after = replay(...uncase(replay(...result.effects), "g1"));
    expect(goal(after, "g1").status).toBe("open");
    expect(after.goals.has("g2")).toBe(false);
  });

  test("is not undone by uncut, which undoes cuts alone", async () => {
    const result = await cases(store, llops, await start(), "g1", BELOW_ZERO);
    if (result.kind !== "cased") throw new Error(result.message);
    const tree = replay(...result.effects);
    const uncut = () => new Cuts(store, llops).uncut(tree, "g1");
    expect(uncut).toThrow(/split by cases, not cut/);
  });

  test("uncase refuses a goal that was not split by cases", async () => {
    const tree = await start();
    expect(() => uncase(tree, "g1")).toThrow(/g1 is open, not split by cases/);
  });
});
