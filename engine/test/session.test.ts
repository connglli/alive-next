// Reading a session: what a writer sees before deciding what to do next.
//
// llops is real, since what `show` answers with is the program the store
// holds, and the checker is a stand-in: nothing here asks whether anything
// refines anything.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import { Session } from "../core/session.ts";
import { DEFAULT_ASSUMPTION } from "../core/state/arguments.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { type Checker, DEFAULT_TIMEOUTS, timeoutsFrom } from "../core/state/steps.ts";
import { parse } from "../core/state/trajectory.ts";
import { cut } from "../examples/cut.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

/** A checker that agrees, so a split is all these tests need to set up. */
class YesMan implements Checker {
  async check(): Promise<CheckResult> {
    return {
      outcome: "correct",
      detail: "",
      invocation: { binary: "yes-man", flags: [], timeoutMs: 0 },
      stdout: "",
      ms: 0,
    };
  }
}

/** Nothing here reports a counterexample, so nothing runs a program. */
const noRun: Interpreter = {
  run() {
    throw new Error("this session has no interpreter");
  },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-session-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function session(): Promise<Session> {
  return Session.start({
    dir: join(dir, "session"),
    src: cut.src,
    tgt: cut.tgt,
    llops,
    checker: new YesMan(),
    interp: noRun,
  });
}

/** The trajectory as it stands, which is what a reader of the run gets. */
function log(run: Session): ReturnType<typeof parse> {
  return parse(readFileSync(join(run.dir, "trajectory.jsonl"), "utf8"));
}

describe.skipIf(!built)("reading a session", () => {
  test("show answers with both sides of a goal", async () => {
    const run = await session();
    const view = await run.show("g1");

    expect(view).toMatchObject({ gid: "g1", status: "open", children: [] });
    expect(view.src.text).toContain("mul i32");
    expect(view.tgt.text).toContain("shl i32");
    // The hash is the name the store keeps it under, so it can be asked for.
    expect(run.store.get(view.src.hash)).toBe(view.src.text);
  });

  test("show says which half of a cut a goal is, and of what", async () => {
    const run = await session();
    const split = await run.split("g1", "%2", "%2", { "%0": "%0", "%1": "%1" });
    if (split.kind !== "split") throw new Error(split.message);

    const callee = await run.show(split.children.callee);
    expect(callee).toMatchObject({ role: "callee", parent: "g1", callee: "outlined_g3" });
    expect(callee.src.text).toContain("define i32 @outlined_g3");
  });

  test("the log keeps the hashes show named, not the programs", async () => {
    const run = await session();
    const view = await run.show("g1");

    const result = log(run).find((entry) => entry.kind === "tool_result");
    if (result?.kind !== "tool_result") throw new Error("no result was logged");
    expect(result.result).toEqual({
      gid: "g1",
      status: "open",
      src: view.src.hash,
      tgt: view.tgt.hash,
    });
    expect(result.effects).toEqual([]);
  });

  test("status is the tree, with the transaction when one is open", async () => {
    const run = await session();
    const split = await run.split("g1", "%2", "%2", { "%0": "%0", "%1": "%1" });
    if (split.kind !== "split") throw new Error(split.message);
    await run.begin(split.children.callee, "src");

    const standing = await run.status();
    expect(standing.root).toBe("g1");
    expect(standing.verdict).toBe("unknown");
    expect(standing.goals.map((goal) => [goal.gid, goal.status])).toEqual([
      ["g1", "split"],
      ["g2", "open"],
      ["g3", "open"],
    ]);
    expect(standing.editing).toMatchObject({ gid: "g3", side: "src", ops: 0 });
  });

  test("status says what a check and a commit may spend", async () => {
    const run = await session();
    expect((await run.status()).budgets).toEqual(DEFAULT_TIMEOUTS);
  });

  test("the run states what it assumes about the pair's arguments", async () => {
    // It is never proved and it decides what every check means, so it is
    // recorded where the question is and read back with the tree.
    const run = await session();
    expect((await run.status()).assumed).toEqual(DEFAULT_ASSUMPTION);

    const start = log(run).find((entry) => entry.kind === "run_start");
    if (start?.kind !== "run_start") throw new Error("no run_start was logged");
    expect(start.assumed).toEqual(DEFAULT_ASSUMPTION);
    // A resumed run reads it back rather than being told again.
    expect(
      Session.resume({ dir: run.dir, llops, checker: new YesMan(), interp: noRun }).tree.assumed,
    ).toEqual(DEFAULT_ASSUMPTION);
  });

  test("the run records the budgets it resolved to, not the file's silence", async () => {
    // A configuration that names no timeout still produced the ones the run
    // spent, and the snapshot is the only place a reader finds them.
    const run = await Session.start({
      dir: join(dir, "budgets"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new YesMan(),
      interp: noRun,
      timeouts: timeoutsFrom({ eagerCheckMs: 100 }),
      config: { toolchain: "/somewhere" },
    });

    const start = log(run).find((entry) => entry.kind === "run_start");
    if (start?.kind !== "run_start") throw new Error("no run_start was logged");
    expect(start.config).toEqual({
      toolchain: "/somewhere",
      timeouts: { ...DEFAULT_TIMEOUTS, eagerCheckMs: 100 },
    });
  });

  test("a side says every program it has been, and any of them can be read", async () => {
    const run = await session();
    const before = await run.show("g1");
    expect(before.src.history).toEqual([before.src.id]);

    await run.begin("g1", "src");
    await run.edit({ op: "replace", v: "%2", insts: ["%s = shl i32 %1, 3"] });
    const step = await run.commit();
    expect(step.kind).toBe("certified");

    const after = await run.show("g1");
    expect(after.src.history).toEqual([before.src.id, after.src.id]);
    // What it was is still readable, which is what naming a revert needs.
    const was = await run.program(before.src.id);
    expect(was.text).toBe(before.src.text);
    expect(was.hash).toBe(before.src.hash);
  });

  test("revert moves a head back to a program its side has been", async () => {
    const run = await session();
    const before = await run.show("g1");
    await run.begin("g1", "src");
    await run.edit({ op: "replace", v: "%2", insts: ["%s = shl i32 %1, 3"] });
    await run.commit();
    // The yes-man discharged it, so this is also the proved case: going back
    // undoes what that proof settled.
    expect(run.tree.goals.get("g1")?.status).toBe("proved");

    const reverted = await run.revert("g1", "src", before.src.id);
    expect(reverted.kind).toBe("reverted");
    const now = await run.show("g1");
    expect(now.src.hash).toBe(before.src.hash);
    expect(now.status).toBe("open");
    // The abandoned step stays in the log, and the history no longer holds it.
    expect(now.src.history).toEqual([before.src.id]);
    expect(log(run).some((entry) => entry.kind === "tool_result" && entry.tool === "commit")).toBe(
      true,
    );
  });

  test("revert refuses a program the side has never been, and its own head", async () => {
    const run = await session();
    const view = await run.show("g1");

    const elsewhere = await run.revert("g1", "src", view.tgt.id);
    expect(elsewhere).toMatchObject({ kind: "refused" });
    if (elsewhere.kind !== "refused") throw new Error("unreachable");
    expect(elsewhere.message).toContain("has never been");

    const standing = await run.revert("g1", "src", view.src.id);
    expect(standing).toMatchObject({ kind: "refused" });
    if (standing.kind !== "refused") throw new Error("unreachable");
    expect(standing.message).toContain("already");
  });

  test("revert refuses while the side is being edited", async () => {
    const run = await session();
    const view = await run.show("g1");
    await run.begin("g1", "src");

    const refused = await run.revert("g1", "src", view.src.id);
    expect(refused).toMatchObject({ kind: "refused" });
    if (refused.kind !== "refused") throw new Error("unreachable");
    expect(refused.message).toContain("a transaction is open");
  });

  test("split refuses while the goal is being edited", async () => {
    const run = await session();
    await run.begin("g1", "src");
    await run.edit({ op: "replace", v: "%2", insts: ["%s = shl i32 %1, 3"] });

    const refused = await run.split("g1", "%2", "%2", { "%0": "%0", "%1": "%1" });
    expect(refused).toMatchObject({ kind: "editing" });
    if (refused.kind !== "editing") throw new Error("unreachable");
    expect(refused.message).toContain("a transaction is open on g1 src");
    expect(run.tree.goals.get("g1")?.status).toBe("open");
    expect((await run.status()).editing).toMatchObject({ gid: "g1", side: "src", ops: 1 });

    const results = log(run).filter((entry) => entry.kind === "tool_result");
    const splitResult = [...results].reverse().find((entry) => entry.tool === "split");
    expect(splitResult).toMatchObject({ tool: "split", result: refused, effects: [] });
  });

  test("unsplit refuses while it would discard an edited child", async () => {
    const run = await session();
    const split = await run.split("g1", "%2", "%2", { "%0": "%0", "%1": "%1" });
    if (split.kind !== "split") throw new Error(split.message);
    await run.begin(split.children.callee, "tgt");

    const refused = await run.unsplit("g1");
    expect(refused).toMatchObject({ kind: "editing" });
    if (refused.kind !== "editing") throw new Error("unreachable");
    expect(refused.message).toContain(`a transaction is open on ${split.children.callee} tgt`);
    expect(run.tree.goals.get("g1")?.status).toBe("split");
    expect(run.tree.goals.has(split.children.callee)).toBe(true);
  });

  test("strengthen refuses while it would move an edited child", async () => {
    const run = await session();
    const split = await run.split("g1", "%2", "%2", { "%0": "%0", "%1": "%1" });
    if (split.kind !== "split") throw new Error(split.message);
    const before = await run.show(split.children.outer);
    await run.begin(split.children.outer, "src");

    const refused = await run.strengthen("g1", { 0: { noundef: true } });
    expect(refused).toMatchObject({ kind: "editing" });
    if (refused.kind !== "editing") throw new Error("unreachable");
    expect(refused.message).toContain(`a transaction is open on ${split.children.outer} src`);
    expect((await run.show(split.children.outer)).src.hash).toBe(before.src.hash);
    expect((await run.status()).editing).toMatchObject({ gid: split.children.outer, side: "src" });
  });

  test("a split preview logs what it found, not the programs it outlined", async () => {
    const run = await session();
    const preview = await run.splitPreview("g1", "%2", "%2", { "%0": "%0", "%1": "%1" });
    if (preview.kind !== "preview") throw new Error(preview.message);

    const results = log(run).filter((entry) => entry.kind === "tool_result");
    const previewResult = [...results].reverse().find((entry) => entry.tool === "split_preview");
    expect(previewResult).toBeDefined();
    if (!previewResult) throw new Error("no split_preview was logged");
    const kept = previewResult.result as Record<string, unknown>;
    expect(kept.kind).toBe("preview");
    expect(kept.callee).toBe(preview.callee);
    expect(kept.programs).toBeUndefined();
  });

  test("a refused edit answers with the program it refused", async () => {
    const run = await session();
    await run.begin("g1", "src");
    // `%0` is the parameter, which is not an instruction to replace.
    const refused = await run.edit({ op: "replace", v: "%0", insts: ["%s = shl i32 %0, 3"] });

    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") throw new Error("unreachable");
    expect(refused.text).toContain("mul i32");

    // The log keeps the refusal, not the program it came back with.
    const results = log(run).filter((entry) => entry.kind === "tool_result");
    const last = results[results.length - 1];
    if (last?.kind !== "tool_result") throw new Error("no result was logged");
    expect(last.result).toEqual({ kind: "refused", code: refused.code, message: refused.message });
  });

  test("session check surfaces check history on repeated checks", async () => {
    class SeqChecker implements Checker {
      private calls = 0;
      async check(): Promise<CheckResult> {
        this.calls++;
        return {
          outcome: this.calls === 1 ? "unknown" : "correct",
          detail: "",
          invocation: {
            binary: "seq-checker",
            flags: [],
            timeoutMs: this.calls === 1 ? 1000 : 5000,
          },
          stdout: "",
          ms: 10,
        };
      }
    }
    const run = await Session.start({
      dir: join(dir, "session-check-hist"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new SeqChecker(),
      interp: noRun,
    });

    const first = await run.check("g1", 1000);
    expect(first.outcome).toBe("unknown");
    expect(first.prior).toBeUndefined();

    const second = await run.check("g1", 5000);
    expect(second.outcome).toBe("proved");
    expect(second.prior).toEqual({
      outcome: "unknown",
      budgetMs: 1000,
      ms: 10,
    });
  });
});
