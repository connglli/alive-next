// Deriving the goal tree from a log.
//
// The fold is pure, so these build event lists by hand rather than running
// anything: what is under test is what a sequence of effects means.
import { describe, expect, test } from "bun:test";
import type { Goal, Tree } from "../core/state/goals.ts";
import { DerivationError, derive, head, openLeaves, verdict } from "../core/state/goals.ts";
import type { Effect, Entry, Event } from "../core/state/trajectory.ts";

/** Entries as the log holds them; the chain is the trajectory's business. */
function log(...events: Event[]): Entry[] {
  return events.map((event) => ({ ...event, time: 0, prev: "" }));
}

function run(src = "hash-src", tgt = "hash-tgt"): Event {
  return { kind: "run_start", src, tgt, config: {}, versions: {} };
}

/** The goal an id names, or a failure here rather than a null check below. */
function goal(tree: Tree, id: string): Goal {
  const found = tree.goals.get(id);
  if (!found) throw new Error(`no goal ${id} in the derived tree`);
  return found;
}

/** A tool result carrying the effects it had, which is how the tree changes. */
function did(...effects: Effect[]): Event {
  return { kind: "tool_result", id: "1", tool: "commit", effects, result: null, ms: 1 };
}

describe("derive", () => {
  test("starts with the root goal and the pair it was asked about", () => {
    const tree = derive(log(run()));
    const root = goal(tree, tree.root);
    expect(root.status).toBe("open");
    expect(head(root, "src")).toBe("hash-src");
    expect(head(root, "tgt")).toBe("hash-tgt");
    expect(verdict(tree)).toBe("unknown");
  });

  test("names programs in the order they first appear", () => {
    const tree = derive(
      log(
        run(),
        did({ effect: "step", gid: "g1", side: "src", to: "hash-2", how: "checked" }),
        did({ effect: "step", gid: "g1", side: "src", to: "hash-3", how: "rule" }),
      ),
    );
    expect([...tree.programs.values()]).toEqual(["p1", "p2", "p3", "p4"]);
    expect(tree.programs.get("hash-src")).toBe("p1");
    expect(tree.programs.get("hash-3")).toBe("p4");
  });

  test("advances a head and keeps the history behind it", () => {
    const tree = derive(
      log(run(), did({ effect: "step", gid: "g1", side: "tgt", to: "hash-2", how: "checked" })),
    );
    const root = goal(tree, "g1");
    expect(root.tgt.history).toEqual(["hash-tgt", "hash-2"]);
    expect(head(root, "src")).toBe("hash-src");
  });

  test("reverting moves the head back and drops what came after", () => {
    const tree = derive(
      log(
        run(),
        did({ effect: "step", gid: "g1", side: "src", to: "hash-2", how: "checked" }),
        did({ effect: "step", gid: "g1", side: "src", to: "hash-3", how: "checked" }),
        did({ effect: "revert", gid: "g1", side: "src", to: "hash-src" }),
      ),
    );
    expect(tree.goals.get("g1")?.src.history).toEqual(["hash-src"]);
    // The abandoned programs keep their names: the log still refers to them.
    expect(tree.programs.get("hash-3")).toBe("p4");
  });

  test("refuses a revert to a program the side never had", () => {
    expect(() =>
      derive(log(run(), did({ effect: "revert", gid: "g1", side: "src", to: "nowhere" }))),
    ).toThrow(DerivationError);
  });

  test("a split freezes the parent and opens two children", () => {
    const tree = derive(log(run(), did(splitG1())));
    expect(tree.goals.get("g1")?.status).toBe("split");
    expect(tree.goals.get("g1")?.children).toEqual(["g2", "g3"]);
    expect(tree.goals.get("g2")?.role).toBe("outer");
    expect(tree.goals.get("g3")?.role).toBe("callee");
    expect(openLeaves(tree).map((goal) => goal.id)).toEqual(["g2", "g3"]);
  });

  test("a split goal takes no steps of its own", () => {
    expect(() =>
      derive(
        log(
          run(),
          did(splitG1()),
          did({ effect: "step", gid: "g1", side: "src", to: "hash-9", how: "checked" }),
        ),
      ),
    ).toThrow(/g1 is split/);
  });

  test("proving both children proves the parent, up to the root", () => {
    const tree = derive(
      log(
        run(),
        did(splitG1()),
        did({ effect: "proved", gid: "g2" }),
        did({ effect: "proved", gid: "g3" }),
      ),
    );
    expect(tree.goals.get("g1")?.status).toBe("proved");
    expect(verdict(tree)).toBe("verified");
  });

  test("one proved child is not enough", () => {
    const tree = derive(log(run(), did(splitG1()), did({ effect: "proved", gid: "g2" })));
    expect(tree.goals.get("g1")?.status).toBe("split");
    expect(verdict(tree)).toBe("unknown");
  });

  test("unsplitting discards the children and reopens the parent", () => {
    const tree = derive(
      log(
        run(),
        did(splitG1()),
        did({ effect: "proved", gid: "g2" }),
        did({ effect: "unsplit", gid: "g1" }),
      ),
    );
    expect(tree.goals.get("g1")?.status).toBe("open");
    expect(tree.goals.get("g1")?.children).toEqual([]);
    expect(tree.goals.has("g2")).toBe(false);
    expect(tree.goals.has("g3")).toBe(false);
  });

  test("unsplitting takes a whole subtree with it", () => {
    const tree = derive(
      log(
        run(),
        did(splitG1()),
        did({
          effect: "split",
          gid: "g3",
          name: "outlined_g5",
          outer: { gid: "g4", src: "h4s", tgt: "h4t" },
          callee: { gid: "g5", src: "h5s", tgt: "h5t" },
        }),
        did({ effect: "unsplit", gid: "g1" }),
      ),
    );
    expect([...tree.goals.keys()]).toEqual(["g1"]);
  });

  test("a split says what it outlined, on both children", () => {
    const tree = derive(log(run(), did(splitG1())));
    expect(goal(tree, "g2").callee).toBe("outlined_g3");
    expect(goal(tree, "g3").callee).toBe("outlined_g3");
  });

  test("strengthening moves both sides of a goal at once", () => {
    const tree = derive(
      log(
        run(),
        did(splitG1()),
        did({
          effect: "strengthen",
          gid: "g3",
          src: "h3s-attr",
          tgt: "h3t-attr",
          by: { gid: "g2", hash: "h2s-assume" },
        }),
      ),
    );
    // One claim about the goal, not a step on either side of it.
    expect(goal(tree, "g3").src.history).toEqual(["h3s", "h3s-attr"]);
    expect(goal(tree, "g3").tgt.history).toEqual(["h3t", "h3t-attr"]);
  });

  test("a step on a proved goal reopens it", () => {
    // The proof was about the pair the step replaces, so it says nothing
    // about the new one; the old discharge stays in the log, unused.
    const tree = derive(
      log(
        run(),
        did({ effect: "proved", gid: "g1" }),
        did({ effect: "step", gid: "g1", side: "src", to: "hash-2", how: "checked" }),
      ),
    );
    expect(goal(tree, "g1").status).toBe("open");
    expect(verdict(tree)).toBe("unknown");
  });

  test("reopening a child undoes what its proof settled above it", () => {
    const tree = derive(
      log(
        run(),
        did(splitG1()),
        did({ effect: "proved", gid: "g2" }),
        did({ effect: "proved", gid: "g3" }),
        did({ effect: "step", gid: "g2", side: "src", to: "h2s-again", how: "checked" }),
      ),
    );
    expect(goal(tree, "g2").status).toBe("open");
    // The parent was proved through its children, so it goes back to split.
    expect(goal(tree, "g1").status).toBe("split");
    expect(goal(tree, "g3").status).toBe("proved");
    expect(verdict(tree)).toBe("unknown");
  });

  test("a refuted root is a counterexample", () => {
    const tree = derive(log(run(), did({ effect: "refuted", gid: "g1" })));
    expect(verdict(tree)).toBe("counterexample");
  });

  test("an eager check discharges a goal the same way a tool does", () => {
    const tree = derive(
      log(run(), {
        kind: "auto",
        action: "eager_check",
        effects: [{ effect: "proved", gid: "g1" }],
        outcome: "proved",
      }),
    );
    expect(verdict(tree)).toBe("verified");
  });

  test("events that change nothing leave the tree alone", () => {
    const tree = derive(
      log(
        run(),
        { kind: "message", message: "thinking" },
        { kind: "tool_call", id: "1", tool: "show", args: {} },
        { kind: "tool_result", id: "1", tool: "show", result: "text", ms: 1 },
      ),
    );
    expect(tree.goals.size).toBe(1);
    expect(verdict(tree)).toBe("unknown");
  });

  test("refuses a log that does not start a run", () => {
    expect(() => derive([])).toThrow(/no run_start/);
    expect(() => derive(log(did({ effect: "proved", gid: "g1" })))).toThrow(/before run_start/);
    expect(() => derive(log(run(), run()))).toThrow(/second run_start/);
  });

  test("refuses an effect on a goal that is not there", () => {
    expect(() => derive(log(run(), did({ effect: "proved", gid: "g9" })))).toThrow(/no goal g9/);
  });
});

function splitG1(): Effect {
  return {
    effect: "split",
    gid: "g1",
    name: "outlined_g3",
    outer: { gid: "g2", src: "h2s", tgt: "h2t" },
    callee: { gid: "g3", src: "h3s", tgt: "h3t" },
  };
}
