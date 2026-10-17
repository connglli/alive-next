// Proving a goal through a program between its two sides.
//
// llops reads the programs, as it would for a run; no solver is involved,
// because the two goals an interpose leaves are proved afterwards. Skips when
// llops is not built.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Llops } from "../core/drivers/llops.ts";
import { Cuts } from "../core/state/cuts.ts";
import { derive, type Goal, head, type Tree } from "../core/state/goals.ts";
import { interpose, uninterpose } from "../core/state/interpose.ts";
import { Store } from "../core/state/store.ts";
import type { Effect, Entry, Event } from "../core/state/trajectory.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

const SRC = `define i32 @f(i32 %x, i32 %y) {
entry:
  %m = mul i32 %x, %y
  %s = add i32 %m, %x
  ret i32 %s
}
`;
const TGT = SRC.replace("add i32 %m, %x", "add i32 %x, %m");
const MIDDLE = SRC.replace("mul i32 %x, %y", "mul i32 %y, %x");

let dir: string;
let store: Store;
let events: Event[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-interpose-"));
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

describe.skipIf(!built)("interposing", () => {
  test("puts a program between the two sides and leaves two goals", async () => {
    const result = await interpose(store, llops, await start(), "g1", MIDDLE);
    if (result.kind !== "interposed") throw new Error(result.message);
    expect(result.children).toEqual({ lhs: "g2", rhs: "g3" });

    const tree = replay(...result.effects);
    const [src, tgt] = [head(goal(tree, "g1"), "src"), head(goal(tree, "g1"), "tgt")];
    expect(goal(tree, "g1").status).toBe("split");
    expect([head(goal(tree, "g2"), "src"), head(goal(tree, "g2"), "tgt")]).toEqual([
      src,
      result.program,
    ]);
    expect([head(goal(tree, "g3"), "src"), head(goal(tree, "g3"), "tgt")]).toEqual([
      result.program,
      tgt,
    ]);
  });

  test("refuses a program that defines another function", async () => {
    const other = MIDDLE.replace("@f", "@g");
    const result = await interpose(store, llops, await start(), "g1", other);
    expect(result.kind === "refused" && result.message).toContain("@g");
  });

  test("refuses a program whose function has another type", async () => {
    const wider = MIDDLE.replace(
      "define i32 @f(i32 %x, i32 %y)",
      "define i32 @f(i32 %x, i64 %z)",
    ).replace("mul i32 %y, %x", "mul i32 %x, %x");
    const result = await interpose(store, llops, await start(), "g1", wider);
    expect(result.kind === "refused" && result.message).toContain("has type i32 (i32, i64)");
  });

  test("refuses one of the goal's sides, which would leave the goal a half", async () => {
    const result = await interpose(store, llops, await start(), "g1", TGT);
    expect(result).toMatchObject({ kind: "refused", code: "invalid" });
  });

  test("refuses a program that does not parse", async () => {
    const result = await interpose(store, llops, await start(), "g1", "define i32 @f(");
    expect(result.kind).toBe("refused");
  });

  test("is undone by uninterpose", async () => {
    const result = await interpose(store, llops, await start(), "g1", MIDDLE);
    if (result.kind !== "interposed") throw new Error(result.message);
    const after = replay(...uninterpose(replay(...result.effects), "g1"));
    expect(goal(after, "g1").status).toBe("open");
    expect(after.goals.has("g2")).toBe(false);
  });

  test("is not undone by uncut, which undoes cuts alone", async () => {
    const result = await interpose(store, llops, await start(), "g1", MIDDLE);
    if (result.kind !== "interposed") throw new Error(result.message);
    const tree = replay(...result.effects);
    const uncut = () => new Cuts(store, llops).uncut(tree, "g1");
    expect(uncut).toThrow(/interposed, not cut/);
  });

  test("uninterpose refuses a goal that was not interposed", async () => {
    const tree = await start();
    expect(() => uninterpose(tree, "g1")).toThrow(/g1 is open, not interposed/);
  });
});
