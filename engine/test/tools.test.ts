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
import {
  createProofAssistantTools,
  createSandboxTools,
  listToolNames,
  SANDBOX_TOOLS,
} from "../agent/tools/index.ts";
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
  surface = createProofAssistantTools(session);
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
    expect(await call("run_status", {})).toContain("g1 root, open");

    const shown = await call("goal_show", { ref: "g1" });
    expect(shown).toContain("src p1");
    expect(shown).toContain("mul i32");

    const cutting = { gid: "g1", src_cut: "%2", tgt_cut: "%2", value_map: SAME };
    expect(await call("tree_split", cutting)).toContain("cut into @outlined_g3");
    expect(await call("goal_show", { ref: "g3" })).toContain("callee of g1");

    const facts = await call("goal_analyze", { gid: "g2", side: "src", kind: "defined" });
    expect(facts).toContain("noundef");

    expect(
      await call("tree_strengthen", { gid: "g1", facts: { "0": { noundef: true } } }),
    ).toContain("stated on 0");

    // The yes-man discharges both halves, and the last of them ends the run.
    expect(await call("goal_check", { gid: "g2" })).toContain("g2 proved");
    const last = await call("goal_check", { gid: "g3" });
    expect(last).toContain("g3 proved");
    expect(last).toContain("the root is verified");
    expect(session.verdict).toBe("verified");
  });

  test("a move that changed the tree says how it stands, and one that did not says nothing", async () => {
    // A cut changes it, so the two children arrive with the answer.
    const split = await call("tree_split", {
      gid: "g1",
      src_cut: "%2",
      tgt_cut: "%2",
      value_map: SAME,
    });
    // A tree line carries both programs, which is what tells it from the
    // heading `goal_show` puts on a goal.
    expect(split).toContain("g2 outer of g1, open, src");
    expect(split).toContain("g3 callee of g1, open, src");

    // Reading changes nothing, and neither does opening a transaction or
    // editing inside it, so none of them repeats a picture the caller has.
    for (const [name, args] of [
      ["goal_show", { ref: "g2" }],
      ["tx_begin", { gid: "g2", side: "src" }],
      ["tx_edit", { op: "commute", v: "%9" }],
    ] as const) {
      expect(await call(name, args)).not.toContain("outer of g1, open, src");
    }

    // A check that proves does change it, and says so.
    await call("tx_abort", {});
    expect(await call("goal_check", { gid: "g2" })).toContain("g2 outer of g1, proved, src");
  });

  test("a verdict is what tells the loop to stop", async () => {
    await call("tree_split", { gid: "g1", src_cut: "%2", tgt_cut: "%2", value_map: SAME });
    const tool = surface.find((candidate) => candidate.name === "goal_check");
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
    const opened = await call("tx_begin", { gid: "g1", side: "src" });
    expect(opened).toContain("editing g1 src");
    expect(opened).toContain("%2 = mul i32 %1, 8");

    // A refusal answers with the program it refused, which is where the value
    // the caller meant is to be found.
    const refused = await call("tx_edit", {
      op: "replace",
      v: "%9",
      insts: ["%s = shl i32 %1, 3"],
    });
    expect(refused).toContain("refused");
    expect(refused).toContain("%2 = mul i32 %1, 8");

    const applied = await call("tx_edit", {
      op: "replace",
      v: "%2",
      insts: ["%s = shl i32 %1, 3"],
    });
    expect(applied).toContain("applied, 1 so far");
    expect(applied).toContain("shl i32");

    // The src is now the tgt, byte for byte, so it is the program the tgt
    // already had a name for, and the check that follows the step proves it.
    // Which question settled the step is not in the answer: the writer has no
    // move that depends on it, and the log and the certificate keep it.
    const committed = await call("tx_commit", {});
    expect(committed).toContain("certified, head is p2");
    expect(committed).not.toContain("window");
    expect(await call("goal_show", { ref: "g1" })).toContain("(was p1)");
  });

  test("an optimizer pass rewrites the scratch like an edit", async () => {
    await call("tx_begin", { gid: "g1", side: "src" });
    await call("tx_edit", { op: "replace", v: "%1", insts: ["%1 = add i32 %0, 0"] });
    const folded = await call("tx_opt", { what: "simplify", v: "%1" });
    expect(folded).toContain("applied, 2 so far");
    expect(folded).toContain("mul i32 %0, 8");
    expect(folded).not.toContain("add i32 %0, 0");
    await call("tx_abort", {});
  });

  test("an optimizer pass that folds nothing says unchanged", async () => {
    await call("tx_begin", { gid: "g1", side: "src" });
    const unchanged = await call("tx_opt", { what: "simplify", v: "%1" });
    expect(unchanged).toContain("unchanged");
    expect(unchanged).toContain("nothing to fold");
    // The ops counter should not have advanced: a no-op is not an op.
    const edited = await call("tx_edit", { op: "replace", v: "%2", insts: ["%s = shl i32 %1, 3"] });
    expect(edited).toContain("applied, 1 so far");
    await call("tx_abort", {});
  });

  test("a flag edit reaches the scratch and the refusals stay loud", async () => {
    await call("tx_begin", { gid: "g1", side: "src" });
    const flagged = await call("tx_edit", { op: "flags", v: "%2", flags: { nuw: true } });
    expect(flagged).toContain("applied, 1 so far");
    expect(flagged).toContain("nuw");

    const refused = await call("tx_edit", { op: "flags", v: "%1", flags: { exact: true } });
    expect(refused).toContain("refused");
    expect(refused).toContain("exact");
    await call("tx_abort", {});
  });

  test("a step can be walked back", async () => {
    await call("tx_begin", { gid: "g1", side: "src" });
    await call("tx_edit", { op: "replace", v: "%2", insts: ["%s = shl i32 %1, 3"] });
    await call("tx_commit", {});

    expect(await call("goal_revert", { gid: "g1", side: "src", to: "p1" })).toContain(
      "g1 src is p1",
    );
    // What it was is still readable, by the name the tree gave it.
    expect(await call("goal_show", { ref: "p2" })).toContain("shl i32");
    expect(await call("run_status", {})).toContain("g1 root, open");
  });

  test("every answer opens by saying whether the move did what it was asked", async () => {
    expect(await call("run_status", {})).toStartWith("SUCCESS");
    expect(await call("goal_show", { ref: "g1" })).toStartWith("SUCCESS");

    await call("tx_begin", { gid: "g1", side: "src" });
    expect(await call("tx_edit", { op: "commute", v: "%9" })).toStartWith("FAILURE");
    expect(await call("tx_edit", { op: "commute", v: "%1" })).toStartWith("SUCCESS");
    await call("tx_abort", {});

    // A check that does not prove is a failure to advance, whatever it taught.
    expect(
      await call("tree_split", { gid: "g1", src_cut: "%2", tgt_cut: "%2", value_map: {} }),
    ).toStartWith("FAILURE");
    expect(await call("goal_revert", { gid: "g1", side: "src", to: "p2" })).toStartWith("FAILURE");
  });

  test("run_give_up says the run is over and carries no proof with it", async () => {
    const said = await call("run_give_up", { reason: "nothing left to cut" });
    expect(said).toStartWith("SUCCESS");
    expect(said).toContain("the run stops here: nothing left to cut");
    // It settles nothing: the verdict still comes from the tree.
    expect(session.verdict).toBe("unknown");
  });
});

/**
 * The surface as data, which is what a provider reads before a run begins.
 *
 * A name or a schema is a property of the tool alone, so none of this needs a
 * toolchain, a model or a session, and a stand-in stands in for the one the
 * tools would reach. What is checked here fails early and far from the proof
 * when it fails at all: a schema a provider rejects comes back as a 400 naming
 * a tool, before the model has been asked anything.
 */
describe("the tool surface", () => {
  const names = listToolNames({} as Session);
  const schemas = [...createSandboxTools("."), ...createProofAssistantTools({} as Session)].map(
    (tool) => ({
      name: tool.name,
      // As the provider will see it, since what is sent is JSON.
      schema: JSON.parse(JSON.stringify(tool.parameters)) as {
        type?: string;
        anyOf?: { type?: string }[];
      },
    }),
  );

  test("the allowlist names the sandbox tools and ours, and nothing else", () => {
    expect(names).toContain("bash");
    expect(new Set(names).size).toBe(names.length);

    // Ours are told from the machine's by the prefix that says what they act
    // on, which is what keeps a name of ours off a name of Pi's however
    // either grows. The sandbox tools keep the bare names on purpose, so they
    // replace the built-ins they stand in for.
    const ours = names.filter(
      (name) => !SANDBOX_TOOLS.includes(name as (typeof SANDBOX_TOOLS)[number]),
    );
    expect(ours).toHaveLength(names.length - SANDBOX_TOOLS.length);
    for (const name of ours) expect(name).toMatch(/^(run|goal|tx|tree)_/);
  });

  test("every tool takes an object, which is what a provider insists on", () => {
    expect(schemas.length).toBe(names.length);
    const notObjects = schemas
      .flatMap(({ name, schema }) => [
        { at: name, type: schema.type },
        // A union of the ways one tool can be called says it is an object at
        // the top, so each of the ways has to be one too.
        ...(schema.anyOf ?? []).map((branch, index) => ({
          at: `${name} branch ${index}`,
          type: branch.type,
        })),
      ])
      .filter((one) => one.type !== "object");
    expect(notObjects).toEqual([]);
  });

  test("nothing is said by reference, which not every provider resolves", () => {
    for (const { name, schema } of schemas) {
      expect(`${name} ${JSON.stringify(schema)}`).not.toContain('"$ref"');
    }
  });
});
