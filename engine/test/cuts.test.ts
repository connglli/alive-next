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
import { Cuts } from "../core/state/cuts.ts";
import type { Goal } from "../core/state/goals.ts";
import { derive, head, type Tree } from "../core/state/goals.ts";
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
  dir = mkdtempSync(join(tmpdir(), "alive-next-cut-"));
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
  events.push({ kind: "tool_result", id: "1", tool: "cut", effects, result: null, ms: 1 });
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

// The same loop with a counter `%2` the src lacks.
const COUNTED = LOOP.replace(
  "  %i.next = add i32 %i, 1\n",
  "  %k = phi i32 [ %n, %entry ], [ %k.next, %loop ]\n  %i.next = add i32 %i, 1\n  %k.next = add i32 %k, -1\n",
);

async function start(program = PROGRAM, other = program) {
  const src = await store.put(program);
  const tgt = await store.put(other);
  events.push({ kind: "start", src, tgt, config: {}, versions: {} });
  return replay();
}

describe.skipIf(!built)("cutting", () => {
  test("cuts both sides and opens two children", async () => {
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(), "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });

    if (result.kind !== "cut") throw new Error(result.message);
    expect(result.children).toEqual({ outer: "g2", callee: "g3" });
    expect(result.callee).toBe("outlined_g3");
    expect(result.params.map((param) => param.live)).toEqual(["%2", "%0"]);

    const tree = record(result.effects);
    expect(tree.goals.get("g1")?.status).toBe("split");
    expect(tree.goals.get("g2")?.role).toBe("outer");
    expect(tree.goals.get("g3")?.role).toBe("callee");
  });

  test("the outer calls what the callee defines, under one name", async () => {
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(), "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (result.kind !== "cut") throw new Error(result.message);

    const tree = record(result.effects);
    const outer = store.get(head(goal(tree, "g2"), "src"));
    const callee = store.get(head(goal(tree, "g3"), "src"));
    expect(outer).toContain(`call i32 @${result.callee}`);
    expect(outer).toContain(`declare i32 @${result.callee}`);
    expect(callee).toContain(`define i32 @${result.callee}`);
  });

  test("what it cut can be put back together", async () => {
    const cuts = new Cuts(store, llops);
    const tree0 = await start();
    const before = store.get(head(goal(tree0, "g1"), "src"));
    const result = await cuts.cut(tree0, "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (result.kind !== "cut") throw new Error(result.message);

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
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(LOOP), "g1", "%bb1", "%bb1", {
      "%1": "%1",
      "%0": "%0",
    });
    if (result.kind !== "cut") throw new Error(result.message);
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
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(branching), "g1", "%1", "%1", { "%0": "%0" });
    if (result.kind !== "cut") throw new Error(result.message);
    const tree = record(result.effects);
    expect(store.get(head(goal(tree, "g2"), "src"))).toContain("call i32 @outlined_g3(i32 %0)");
    expect(store.get(head(goal(tree, "g3"), "src"))).toContain("br i1");
    expect(goal(tree, "g3").detach).toBeUndefined();
  });

  test("a cut of the src alone keeps the tgt as it is and proves its callee goal", async () => {
    const cuts = new Cuts(store, llops);
    const parent = await start(LOOP, PROGRAM);
    const result = await cuts.cut(parent, "g1", "%bb1");
    if (result.kind !== "cut") throw new Error(result.message);
    const tree = record(result.effects);
    const [outer, callee] = [goal(tree, "g2"), goal(tree, "g3")];
    expect(head(outer, "tgt")).toBe(head(goal(parent, "g1"), "tgt"));
    expect(store.get(head(outer, "src"))).toContain("call i32 @outlined_g3(");
    expect(head(callee, "tgt")).toBe(head(callee, "src"));
    expect(callee.status).toBe("proved");
    expect(outer.src_alone).toBe(true);
    expect(callee.detach).toEqual({ phis: { src: [0], tgt: [] }, hypothesis: "outlined_g3.ih" });
  });

  test("a cut of the src alone refuses a name the tgt has taken", async () => {
    const cuts = new Cuts(store, llops);
    const taken = `declare i32 @outlined_g3(i32)\n\n${PROGRAM}`;
    const result = await cuts.cut(await start(LOOP, taken), "g1", "%bb1");
    expect(result).toMatchObject({ kind: "refused", side: "tgt", code: "invalid" });
  });

  test("a cut of the src alone refuses a point the src does not have", async () => {
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(LOOP, PROGRAM), "g1", "%bb9");
    expect(result).toMatchObject({ kind: "refused", side: "src" });
  });

  test("refuses a block that heads a loop on one side only", async () => {
    const once = LOOP.replace(", [ %i.next, %loop ]", "").replace(
      "br i1 %c, label %loop, label %exit",
      "br label %exit",
    );
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(LOOP, once), "g1", "%bb1", "%bb1", {
      "%1": "%1",
      "%0": "%0",
    });
    expect(result).toMatchObject({ kind: "refused", code: "invalid" });
    if (result.kind === "refused") expect(result.message).toContain("one side only");
  });

  test("carries state only the tgt has, which the src passes as poison", async () => {
    // The tgt's `%2` is a counter the src lacks, so it goes under the new key `k`.
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(LOOP, COUNTED), "g1", "%bb1", "%bb1", {
      "%1": "%1",
      "%0": "%0",
      k: "%2",
    });
    if (result.kind !== "cut") throw new Error(result.message);
    expect(result.params.map((param) => param.live)).toEqual(["%1", "%0", "poison"]);
    const tree = record(result.effects);
    expect(store.get(head(goal(tree, "g2"), "src"))).toContain("i32 poison)");
    expect(goal(tree, "g3").detach?.phis).toEqual({ src: [0], tgt: [0, 2] });
  });

  test("a preview lists the tgt's values at its cut, the src's among them or not", async () => {
    const preview = await new Cuts(store, llops).preview(
      await start(LOOP, COUNTED),
      "g1",
      "%bb1",
      "%bb1",
    );
    if (preview.kind !== "preview") throw new Error(preview.message);
    expect(preview.params.map((param) => param.live)).toEqual(["%1", "%0"]);
    expect(preview.tgtParams?.map((param) => param.live)).toEqual(["%1", "%2", "%0"]);
  });

  test("a preview says which values are what a stack slot holds", async () => {
    const slotted = `define i32 @f(i32 %n) {
entry:
  %i = alloca i32, align 4
  store i32 0, ptr %i, align 4
  br label %loop

loop:
  %0 = load i32, ptr %i, align 4
  %1 = add i32 %0, 1
  store i32 %1, ptr %i, align 4
  %c = icmp ult i32 %1, %n
  br i1 %c, label %loop, label %exit

exit:
  ret i32 %0
}
`;
    const cuts = new Cuts(store, llops);
    const preview = await cuts.preview(await start(slotted, LOOP), "g1", "%bb1", "%bb1");
    if (preview.kind !== "preview") throw new Error(preview.message);
    expect(preview.slots).toEqual({ src: [0], tgt: [] });
  });

  test("refuses a cut whose halves do not go back together as the side", async () => {
    // One tgt phi stands for two src phis, which detach takes and reattach
    // cannot undo: the tgt comes back with two phis.
    const twin = LOOP.replace(
      "  %i.next = add i32 %i, 1\n",
      "  %j = phi i32 [ 0, %entry ], [ %j.next, %loop ]\n  %i.next = add i32 %i, 1\n  %j.next = add i32 %j, 1\n",
    ).replace("  ret i32 %i\n", "  %r = add i32 %i, %j\n  ret i32 %r\n");
    const single = LOOP.replace("  ret i32 %i\n", "  %r = add i32 %i, %i\n  ret i32 %r\n");
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(twin, single), "g1", "%bb1", "%bb1", {
      "%1": "%1",
      "%2": "%1",
      "%0": "%0",
    });
    expect(result).toMatchObject({ kind: "refused", side: "tgt", code: "invalid" });
    if (result.kind === "refused") expect(result.message).toContain("another program");
  });

  test("reads a block off the program's labels", async () => {
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(LOOP), "g1", "%entry", "%entry", {});
    expect(result).toMatchObject({ kind: "refused", side: "src", code: "invalid" });
    if (result.kind === "refused") expect(result.message).toContain("entry block");
  });

  test("refuses a block on one side and a value on the other", async () => {
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(LOOP), "g1", "%bb1", "%2", { "%1": "%1" });
    expect(result).toMatchObject({ kind: "refused", code: "invalid" });
  });

  test("refuses a cut point that is not there, naming the side", async () => {
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(), "g1", "%nope", "%3", {});
    expect(result).toMatchObject({ kind: "refused", side: "src", code: "not_found" });
  });

  test("refuses a side whose attributes change what its instructions may do", async () => {
    const held = PROGRAM.replace("%y) {", "%y) nofree memory(none) {");
    const [cuts, map] = [new Cuts(store, llops), { "%2": "%2", "%0": "%0" }];
    for (const [side, pair] of [
      ["tgt", [PROGRAM, held]],
      ["src", [held, PROGRAM]],
    ] as const) {
      const result = await cuts.cut(await start(...pair), "g1", "%3", "%3", map);
      expect(result).toMatchObject({ kind: "refused", side, code: "invalid" });
      expect(result.kind === "refused" && result.message).toContain("nofree, memory(none)");
      expect(result.kind === "refused" && result.message).toContain("until the drop_attrs edit");
      events = [];
    }
  });

  test("names the attributes no edit removes", async () => {
    const held = PROGRAM.replace("%y) {", "%y) nofree null_pointer_is_valid {");
    const map = { "%2": "%2", "%0": "%0" };
    const result = await new Cuts(store, llops).cut(
      await start(PROGRAM, held),
      "g1",
      "%3",
      "%3",
      map,
    );
    expect(result.kind === "refused" && result.message).toContain(
      "and no edit removes null_pointer_is_valid",
    );
  });

  test("refuses a map that leaves a live value uncovered", async () => {
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(), "g1", "%3", "%3", { "%2": "%2" });
    // The cut points do not line up yet, which is the agent's signal to
    // rewrite a side before cutting.
    expect(result).toMatchObject({ kind: "refused", side: "tgt" });
  });

  test("stores nothing when a side refuses", async () => {
    const cuts = new Cuts(store, llops);
    const tree = await start();
    const before = store.hashes().length;
    await cuts.cut(tree, "g1", "%3", "%nope", { "%2": "%2", "%0": "%0" });
    expect(store.hashes()).toHaveLength(before);
  });

  test("refuses to cut a goal that is not open", async () => {
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(), "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (result.kind !== "cut") throw new Error(result.message);
    const tree = record(result.effects);
    await expect(cuts.cut(tree, "g1", "%3", "%3", {})).rejects.toThrow(/g1 is split/);
  });
});

describe.skipIf(!built)("uncutting", () => {
  test("discards the children and reopens the parent", async () => {
    const cuts = new Cuts(store, llops);
    const result = await cuts.cut(await start(), "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (result.kind !== "cut") throw new Error(result.message);

    const tree = record(result.effects);
    const after = record(cuts.uncut(tree, "g1"));
    expect(after.goals.get("g1")?.status).toBe("open");
    expect(after.goals.has("g2")).toBe(false);
  });

  test("the next cut gets fresh names, not the discarded ones", async () => {
    const cuts = new Cuts(store, llops);
    let tree = await start();
    const first = await cuts.cut(tree, "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (first.kind !== "cut") throw new Error(first.message);
    tree = record(first.effects);
    tree = record(cuts.uncut(tree, "g1"));

    const second = await cuts.cut(tree, "g1", "%3", "%3", { "%2": "%2", "%0": "%0" });
    if (second.kind !== "cut") throw new Error(second.message);
    // g2 and g3 were used once and are not handed out again, so a trajectory
    // names one goal one thing.
    expect(second.children).toEqual({ outer: "g4", callee: "g5" });
  });

  test("refuses a goal that was never cut", async () => {
    const cuts = new Cuts(store, llops);
    const tree = await start();
    expect(() => cuts.uncut(tree, "g1")).toThrow(/g1 is open, not cut/);
  });
});
