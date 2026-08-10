// Driving a proof through the tool layer, with no model in front of it.
//
// The moves below are the `cut` example said as tool calls, which is what the
// layer is for: a scripted caller and a model reach the same session through
// the same door. Every call is checked against the tool's own schema first,
// because a schema that does not accept what we mean to send is the failure
// this layer is most likely to have.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { toolNames, tools } from "../agent/tools/index.ts";
import type { CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import type { Checker } from "../core/state/steps.ts";
import { cut } from "../examples/cut.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

/** A checker that agrees, so what is under test is the layer and not a proof. */
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

/** The two values the cut's suffix uses, each crossing as itself. */
const SAME = { "%0": "%0", "%1": "%1" };

const noRun: Interpreter = {
  run() {
    throw new Error("this session has no interpreter");
  },
};

let dir: string;
let session: Session;
let surface: ToolDefinition[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-tools-"));
  session = await Session.start({
    dir: join(dir, "session"),
    src: cut.src,
    tgt: cut.tgt,
    llops,
    checker: new YesMan(),
    interp: noRun,
  });
  surface = tools(session);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Call one tool the way Pi does, schema first. */
async function call(name: string, args: unknown): Promise<string> {
  const tool = surface.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  expect(Check(tool.parameters, args)).toBe(true);
  const result = await tool.execute(`t-${name}`, args, undefined, undefined, undefined as never);
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

describe.skipIf(!built)("the tool layer", () => {
  test("proves a pair, one tool call at a time", async () => {
    expect(await call("status", {})).toContain("g1 root, open");

    const shown = await call("show", { ref: "g1" });
    expect(shown).toContain("src p1");
    expect(shown).toContain("mul i32");

    const cutting = { gid: "g1", src_cut: "%2", tgt_cut: "%2", value_map: SAME };
    expect(await call("split", cutting)).toContain("cut into @outlined_g3");
    expect(await call("show", { ref: "g3" })).toContain("callee of g1");

    const facts = await call("analyze", { gid: "g2", side: "src", kind: "defined" });
    expect(facts).toContain("noundef");

    expect(await call("strengthen", { gid: "g1", facts: { "0": { noundef: true } } })).toContain(
      "stated on 0",
    );

    // The yes-man discharges both halves, and the last of them ends the run.
    expect(await call("check", { gid: "g2" })).toContain("g2 proved");
    const last = await call("check", { gid: "g3" });
    expect(last).toContain("g3 proved");
    expect(last).toContain("the root is verified");
    expect(session.verdict).toBe("verified");
  });

  test("a move that changed the tree says how it stands, and one that did not says nothing", async () => {
    // A cut changes it, so the two children arrive with the answer.
    const split = await call("split", {
      gid: "g1",
      src_cut: "%2",
      tgt_cut: "%2",
      value_map: SAME,
    });
    // A tree line carries both programs, which is what tells it from the
    // heading `show` puts on a goal.
    expect(split).toContain("g2 outer of g1, open, src");
    expect(split).toContain("g3 callee of g1, open, src");

    // Reading changes nothing, and neither does opening a transaction or
    // editing inside it, so none of them repeats a picture the caller has.
    for (const [name, args] of [
      ["show", { ref: "g2" }],
      ["begin", { gid: "g2", side: "src" }],
      ["edit", { op: "commute", v: "%9" }],
    ] as const) {
      expect(await call(name, args)).not.toContain("outer of g1, open, src");
    }

    // A check that proves does change it, and says so.
    await call("abort", {});
    expect(await call("check", { gid: "g2" })).toContain("g2 outer of g1, proved, src");
  });

  test("a verdict is what tells the loop to stop", async () => {
    await call("split", { gid: "g1", src_cut: "%2", tgt_cut: "%2", value_map: SAME });
    const tool = surface.find((candidate) => candidate.name === "check");
    if (!tool) throw new Error("no check tool");

    const open = await tool.execute("t1", { gid: "g2" }, undefined, undefined, undefined as never);
    expect(open.terminate).toBeUndefined();
    const settled = await tool.execute(
      "t2",
      { gid: "g3" },
      undefined,
      undefined,
      undefined as never,
    );
    expect(settled.terminate).toBe(true);
  });

  test("a transaction reads and writes through the tools", async () => {
    const opened = await call("begin", { gid: "g1", side: "src" });
    expect(opened).toContain("editing g1 src");
    expect(opened).toContain("%2 = mul i32 %1, 8");

    // A refusal answers with the program it refused, which is where the value
    // the caller meant is to be found.
    const refused = await call("edit", { op: "replace", v: "%9", insts: ["%s = shl i32 %1, 3"] });
    expect(refused).toContain("refused");
    expect(refused).toContain("%2 = mul i32 %1, 8");

    const applied = await call("edit", { op: "replace", v: "%2", insts: ["%s = shl i32 %1, 3"] });
    expect(applied).toContain("applied, 1 so far");
    expect(applied).toContain("shl i32");

    // The src is now the tgt, byte for byte, so it is the program the tgt
    // already had a name for, and the check that follows the step proves it.
    expect(await call("commit", {})).toContain("certified, head is p2");
    expect(await call("show", { ref: "g1" })).toContain("(was p1)");
  });

  test("a step can be walked back", async () => {
    await call("begin", { gid: "g1", side: "src" });
    await call("edit", { op: "replace", v: "%2", insts: ["%s = shl i32 %1, 3"] });
    await call("commit", {});

    expect(await call("revert", { gid: "g1", side: "src", to: "p1" })).toContain("g1 src is p1");
    // What it was is still readable, by the name the tree gave it.
    expect(await call("show", { ref: "p2" })).toContain("shl i32");
    expect(await call("status", {})).toContain("g1 root, open");
  });

  test("every answer opens by saying whether the move did what it was asked", async () => {
    expect(await call("status", {})).toStartWith("SUCCESS");
    expect(await call("show", { ref: "g1" })).toStartWith("SUCCESS");

    await call("begin", { gid: "g1", side: "src" });
    expect(await call("edit", { op: "commute", v: "%9" })).toStartWith("FAILURE");
    expect(await call("edit", { op: "commute", v: "%1" })).toStartWith("SUCCESS");
    await call("abort", {});

    // A check that does not prove is a failure to advance, whatever it taught.
    expect(
      await call("split", { gid: "g1", src_cut: "%2", tgt_cut: "%2", value_map: {} }),
    ).toStartWith("FAILURE");
    expect(await call("revert", { gid: "g1", side: "src", to: "p2" })).toStartWith("FAILURE");
  });

  test("give_up says the run is over and carries no proof with it", async () => {
    const said = await call("give_up", { reason: "nothing left to cut" });
    expect(said).toStartWith("SUCCESS");
    expect(said).toContain("the run stops here: nothing left to cut");
    // It settles nothing: the verdict still comes from the tree.
    expect(session.verdict).toBe("unknown");
  });

  test("the allowlist names Pi's tools and ours, and nothing else", async () => {
    const names = toolNames(session);
    expect(names).toContain("bash");
    expect(names).not.toContain("edit_file");
    // `edit` is ours here: Pi's file editor is not in the list.
    expect(names.filter((name) => name === "edit")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });
});
