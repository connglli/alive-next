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
import type { Interpreter } from "../core/state/counterexamples.ts";
import type { Checker } from "../core/state/steps.ts";
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
});
