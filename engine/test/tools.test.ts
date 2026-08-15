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
import type { CheckOptions, CheckResult } from "../core/drivers/alive2.ts";
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

/** A checker that rejects every candidate, for transaction refusal paths. */
class NoMan implements Checker {
  async check(): Promise<CheckResult> {
    return {
      outcome: "incorrect",
      detail: "counterexample",
      invocation: { binary: "no-man", flags: [], timeoutMs: 0 },
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
  return callFrom(surface, name, args);
}

/** Call through a supplied tool surface, after checking the public schema. */
async function callFrom(tools: ToolDefinition[], name: string, args: unknown): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
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

  test("a refused commit keeps its scratch open", async () => {
    const refusing = await Session.start({
      dir: join(dir, "refusing"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new NoMan(),
      interp: noRun,
    });
    const refusingTools = createProofAssistantTools(refusing);

    await callFrom(refusingTools, "tx_begin", { gid: "g1", side: "src" });
    await callFrom(refusingTools, "tx_edit", { op: "commute", v: "%2" });
    const refused = await callFrom(refusingTools, "tx_commit", {});

    expect(refused).toContain("transaction remains open");
    expect(await callFrom(refusingTools, "run_status", {})).toContain(
      "editing g1 src, 1 ops so far",
    );
    expect(await callFrom(refusingTools, "tx_edit", { op: "commute", v: "%2" })).toContain(
      "applied, 2 so far",
    );
    expect(await callFrom(refusingTools, "tx_abort", {})).toContain("dropped 2 ops");
  });

  test("a set_body that pastes a whole define is refused by the contract", async () => {
    await call("tx_begin", { gid: "g1", side: "src" });
    const refused = await call("tx_edit", {
      op: "set_body",
      body: "define i32 @f(i32 noundef %x) {\nentry:\n  %a = add i32 %x, 1\n  ret i32 %a\n}\n",
    });
    expect(refused).toContain("set_body_contract");
    expect(refused).toContain("instructions after 'entry:'");
    await call("tx_abort", {});
  });

  test("a replace whose snippet ends the block is refused by the contract", async () => {
    await call("tx_begin", { gid: "g1", side: "src" });
    const refused = await call("tx_edit", {
      op: "replace",
      v: "%1",
      insts: ["  %g = add i32 %0, 1", "  ret i32 %g"],
    });
    expect(refused).toContain("snippet_terminator");
    expect(refused).toContain("stays in place");
    await call("tx_abort", {});
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

  test("goal_check reports earlier check history on retry", async () => {
    class SequenceChecker implements Checker {
      constructor(private outcomes: ("correct" | "incorrect" | "unknown")[]) {}
      async check(): Promise<CheckResult> {
        const outcome = this.outcomes.shift() ?? "unknown";
        return {
          outcome,
          detail: "",
          invocation: {
            binary: "seq-checker",
            flags: [],
            timeoutMs: outcome === "correct" ? 5000 : 1000,
          },
          stdout: "",
          ms: 5,
        };
      }
    }
    const seqSession = await Session.start({
      dir: join(dir, "seq-session"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new SequenceChecker(["unknown", "correct"]),
      interp: noRun,
    });
    const seqTools = createProofAssistantTools(seqSession);

    const first = await callFrom(seqTools, "goal_check", { gid: "g1", timeout_ms: 1000 });
    expect(first).toContain("g1 unknown, 1000ms budget");
    expect(first).not.toContain("earlier check");

    const second = await callFrom(seqTools, "goal_check", { gid: "g1", timeout_ms: 5000 });
    expect(second).toContain("earlier check: unknown on a 1000ms budget; g1 proved, 5000ms budget");
  });

  test("tx_commit surfaces eager check outcome with budget and elapsed time", async () => {
    class EagerSeqChecker implements Checker {
      constructor(private outcomes: ("correct" | "incorrect" | "unknown")[]) {}
      async check(): Promise<CheckResult> {
        const outcome = this.outcomes.shift() ?? "unknown";
        return {
          outcome,
          detail: "",
          invocation: { binary: "seq-checker", flags: [], timeoutMs: 3000 },
          stdout: "",
          ms: 7,
        };
      }
    }
    const eagerSession = await Session.start({
      dir: join(dir, "eager-seq-session"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new EagerSeqChecker(["correct", "unknown"]),
      interp: noRun,
    });
    const eagerTools = createProofAssistantTools(eagerSession);

    await callFrom(eagerTools, "tx_begin", { gid: "g1", side: "src" });
    await callFrom(eagerTools, "tx_edit", {
      op: "replace",
      v: "%2",
      insts: ["%s = shl i32 %1, 3"],
    });
    const res = await callFrom(eagerTools, "tx_commit", {});
    expect(res).toContain("certified, head is p2, the new pair is unknown (7ms, 3000ms budget)");
  });

  test("tx_commit surfaces counterexample detail when eager check is refuted", async () => {
    class EagerCexChecker implements Checker {
      constructor(private outcomes: ("correct" | "incorrect" | "unknown")[]) {}
      async check(): Promise<CheckResult> {
        const outcome = this.outcomes.shift() ?? "unknown";
        return {
          outcome,
          detail: outcome === "incorrect" ? "Example:\ni32 %x = 42" : "",
          invocation: { binary: "seq-checker", flags: [], timeoutMs: 3000 },
          stdout: "",
          ms: 12,
        };
      }
    }
    const eagerSession = await Session.start({
      dir: join(dir, "eager-cex-session"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new EagerCexChecker(["correct", "incorrect"]),
      interp: noRun,
    });
    const eagerTools = createProofAssistantTools(eagerSession);

    await callFrom(eagerTools, "tx_begin", { gid: "g1", side: "src" });
    await callFrom(eagerTools, "tx_edit", {
      op: "replace",
      v: "%2",
      insts: ["%s = shl i32 %1, 3"],
    });
    const res = await callFrom(eagerTools, "tx_commit", {});
    expect(res).toContain("certified, head is p2, the new pair is refuted (12ms, 3000ms budget)");
    expect(res).toContain("Example:\ni32 %x = 42");
  });

  test("tx_commit surfaces fallback reason on whole-function fallback", async () => {
    class FallbackChecker implements Checker {
      constructor(private outcomes: ("correct" | "incorrect" | "unknown")[]) {}
      async check(_src: string, _tgt: string, options: CheckOptions = {}): Promise<CheckResult> {
        const outcome = this.outcomes.shift() ?? "unknown";
        return {
          outcome,
          detail: "",
          invocation: { binary: "fb-checker", flags: [], timeoutMs: options.timeoutMs ?? 3000 },
          stdout: "",
          ms: 12,
        };
      }
    }
    const fbSession = await Session.start({
      dir: join(dir, "fb-session"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new FallbackChecker(["unknown", "correct", "unknown"]),
      interp: noRun,
    });
    const fbTools = createProofAssistantTools(fbSession);

    await callFrom(fbTools, "tx_begin", { gid: "g1", side: "src" });
    await callFrom(fbTools, "tx_edit", { op: "replace", v: "%2", insts: ["%s = shl i32 %1, 3"] });
    const res = await callFrom(fbTools, "tx_commit", {});
    expect(res).toContain(
      "whole-function fallback: window check (before: #1..#1, after: #1..#1) was unknown in 12ms on a 3000ms budget",
    );
  });

  test("tx_commit surfaces fallback reason on refused step", async () => {
    class RefusedFallbackChecker implements Checker {
      constructor(private outcomes: ("correct" | "incorrect" | "unknown")[]) {}
      async check(_src: string, _tgt: string, options: CheckOptions = {}): Promise<CheckResult> {
        const outcome = this.outcomes.shift() ?? "unknown";
        return {
          outcome,
          detail: "",
          invocation: { binary: "rfb-checker", flags: [], timeoutMs: options.timeoutMs ?? 3000 },
          stdout: "",
          ms: 15,
        };
      }
    }
    const rfbSession = await Session.start({
      dir: join(dir, "rfb-session"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: new RefusedFallbackChecker(["unknown", "unknown"]),
      interp: noRun,
    });
    const rfbTools = createProofAssistantTools(rfbSession);

    await callFrom(rfbTools, "tx_begin", { gid: "g1", side: "src" });
    await callFrom(rfbTools, "tx_edit", { op: "replace", v: "%2", insts: ["%s = shl i32 %1, 3"] });
    const res = await callFrom(rfbTools, "tx_commit", {});
    expect(res).toContain(
      "refused on a 30000ms budget: unknown (whole-function fallback: window check (before: #1..#1, after: #1..#1) was unknown in 15ms on a 3000ms budget); transaction remains open",
    );
  });

  test("tree_split_preview discovers live-ins and validates candidate cuts without mutating tree", async () => {
    const previewSession = await Session.start({
      dir: join(dir, "preview-session"),
      src: cut.src,
      tgt: cut.tgt,
      llops,
      checker: {
        check: async () => ({
          outcome: "unknown",
          detail: "",
          invocation: { binary: "stub", flags: [], timeoutMs: 3000 },
          stdout: "",
          ms: 5,
        }),
      },
      interp: noRun,
    });
    const previewTools = createProofAssistantTools(previewSession);

    // 1. Preview without value_map -> discovers signature
    const sigRes = await callFrom(previewTools, "tree_split_preview", {
      gid: "g1",
      src_cut: "%2",
      tgt_cut: "%2",
    });
    expect(sigRes).toContain("Preview of cut on g1 at src %2, tgt %2:");
    expect(sigRes).toContain("parameters:");
    expect(sigRes).toContain("the src's %1");
    expect(sigRes).toContain("Provide value_map");
    // Ensure goal tree was NOT modified
    expect(previewSession.tree.goals.get("g1")?.status).toBe("open");

    // 2. Preview with valid value_map
    const validRes = await callFrom(previewTools, "tree_split_preview", {
      gid: "g1",
      src_cut: "%2",
      tgt_cut: "%2",
      value_map: { "%0": "%0", "%1": "%1" },
    });
    expect(validRes).toContain("value_map is valid. Both sides outline cleanly.");
    expect(previewSession.tree.goals.get("g1")?.status).toBe("open");

    // 3. Preview with invalid value_map -> refused
    const invalidRes = await callFrom(previewTools, "tree_split_preview", {
      gid: "g1",
      src_cut: "%2",
      tgt_cut: "%2",
      value_map: { "%0": "%nonexistent", "%1": "%1" },
    });
    expect(invalidRes).toContain("FAILURE");
    expect(invalidRes).toContain("refused");
    expect(previewSession.tree.goals.get("g1")?.status).toBe("open");
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
