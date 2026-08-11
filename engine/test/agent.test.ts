// The loop, with a stub where the model goes.
//
// What is under test is the wiring: that a tool call reaches our session, that
// its result reaches the next turn, that the trajectory says what happened,
// and that the run stops when it is settled or spent. None of that is about a
// model, so none of it waits for one: the stub answers with the turns a model
// would have taken, and the same test runs on a machine with no server.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProofAssistant, createServices } from "../agent/agent.ts";
import { Budget } from "../agent/budget.ts";
import type { CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import type { Checker } from "../core/state/steps.ts";
import { parse } from "../core/state/trajectory.ts";
import { strengthReduce } from "../examples/strength-reduce.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

/** A checker that agrees, so the stub's moves are the only thing under test. */
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

const noRun: Interpreter = {
  run() {
    throw new Error("this session has no interpreter");
  },
};

/** One assistant turn: some text, and the tool calls it asked for. */
function turn(text: string, calls: { name: string; arguments: Record<string, unknown> }[] = []) {
  const content: AssistantMessage["content"] = [{ type: "text", text }];
  for (const [at, call] of calls.entries()) {
    content.push({ type: "toolCall", id: `c${at}`, name: call.name, arguments: call.arguments });
  }
  return {
    role: "assistant" as const,
    content,
    api: "openai-completions" as const,
    provider: "stub",
    model: "stub",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: (calls.length > 0 ? "toolUse" : "stop") as AssistantMessage["stopReason"],
    timestamp: 0,
  } satisfies AssistantMessage;
}

/** A model that says these turns in order, and then stops talking. */
function saying(turns: AssistantMessage[]) {
  let at = 0;
  return () => {
    const message = turns[at++] ?? turn("nothing left to try");
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    for (const [contentIndex, part] of message.content.entries()) {
      if (part.type === "toolCall") {
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: part as ToolCall,
          partial: message,
        });
      }
    }
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
    return stream;
  };
}

/**
 * A runtime holding one model that is never called, since the stub answers in
 * its place. Every path it reads is inside `at`, so the loop under test is the
 * same loop on every machine and touches nobody's Pi configuration. The key is
 * a placeholder because Pi declines to prompt a provider with no credential at
 * all, which it checks before it would reach the stub.
 */
async function stubRuntime(at: string): Promise<{ models: ModelRuntime; model: Model<Api> }> {
  const models = await ModelRuntime.create({
    authPath: join(at, "auth.json"),
    modelsPath: join(at, "models.json"),
  });
  models.registerProvider("stub", {
    name: "stub",
    baseUrl: "http://127.0.0.1:1/v1",
    api: "openai-completions",
    apiKey: "unused",
    models: [
      {
        id: "stub",
        name: "stub",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 4096,
      },
    ],
  });
  const model = models.getModel("stub", "stub");
  if (!model) throw new Error("the stub provider did not register");
  return { models, model };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-agent-"));
  mkdirSync(join(dir, "scratch"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function agent(turns: AssistantMessage[], maxSteps = 8) {
  const session = await Session.start({
    dir: join(dir, "session"),
    src: strengthReduce.src,
    tgt: strengthReduce.tgt,
    llops,
    checker: new YesMan(),
    interp: noRun,
  });
  const { models, model } = await stubRuntime(join(dir, "pi"));
  const built = await createProofAssistant({
    session,
    limits: { maxSteps },
    choice: { model },
    // Pi's own directory and the project layer both inside the temporary one,
    // so a run reads neither the machine's settings nor this repository's.
    services: await createServices({
      cwd: join(dir, "scratch"),
      agentDir: join(dir, "pi"),
      project: dir,
      models,
    }),
  });
  built.pi.agent.streamFunction = saying(turns);
  return { session, ...built };
}

/** The trajectory, which is the only record of what happened. */
function log(session: Session) {
  return parse(readFileSync(join(session.dir, "trajectory.jsonl"), "utf8"));
}

describe("the budget", () => {
  test("stops on the step it is given", () => {
    const budget = new Budget({ maxSteps: 2 });
    expect(budget.spend()).toBeUndefined();
    expect(budget.spend()).toContain("2 steps");
  });

  test("stops on the clock", () => {
    let now = 1000;
    const budget = new Budget({ maxSeconds: 30 }, () => now);
    expect(budget.spend()).toBeUndefined();
    now += 31_000;
    expect(budget.spend()).toContain("31 seconds");
  });

  test("with no limits it never stops", () => {
    const budget = new Budget();
    for (let at = 0; at < 100; at += 1) expect(budget.spend()).toBeUndefined();
    expect(budget.spent.steps).toBe(100);
  });
});

describe.skipIf(!built)("the loop", () => {
  test("a tool call reaches the session, and its result the next turn", async () => {
    const { session, prove } = await agent([
      turn("looking", [{ name: "run_status", arguments: {} }]),
      turn("proving", [{ name: "goal_check", arguments: { gid: "g1" } }]),
    ]);
    expect(await prove()).toBe("verified");

    const entries = log(session);
    const calls = entries.filter((entry) => entry.kind === "tool_call").map((entry) => entry.tool);
    expect(calls).toEqual(["status", "check"]);

    // What the model said and what it was answered are both in the record.
    const messages = entries.filter((entry) => entry.kind === "message");
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const answered = JSON.stringify(messages.map((entry) => entry.message));
    expect(answered).toContain("SUCCESS");
    expect(answered).toContain("g1 proved");
  });

  /**
   * The configuration does not name a model, so what produced a run is read
   * off what it said. Every assistant message carries it, which is also why
   * nothing records it a second time.
   */
  test("what produced a turn is in the record", async () => {
    const { session, prove } = await agent([
      turn("proving", [{ name: "goal_check", arguments: { gid: "g1" } }]),
    ]);
    expect(await prove()).toBe("verified");

    const said = log(session)
      .filter((entry) => entry.kind === "message")
      .map((entry) => entry.message as { role?: string; provider?: string; model?: string })
      .filter((message) => message.role === "assistant");
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]?.provider).toBe("stub");
    expect(said[0]?.model).toBe("stub");
  });

  test("a verdict ends the run, whatever the model meant to do next", async () => {
    const { session, prove } = await agent([
      turn("proving", [{ name: "goal_check", arguments: { gid: "g1" } }]),
      turn("still going", [{ name: "run_status", arguments: {} }]),
    ]);
    expect(await prove()).toBe("verified");

    // The second turn never happened: the tool that settled the root said so.
    const calls = log(session).filter((entry) => entry.kind === "tool_call");
    expect(calls.map((entry) => entry.tool)).toEqual(["check"]);
    expect(session.verdict).toBe("verified");
  });

  test("a budget stops a model going in circles, and says so", async () => {
    const going = Array.from({ length: 10 }, () =>
      turn("again", [{ name: "run_status", arguments: {} }]),
    );
    const { session, prove } = await agent(going, 3);
    expect(await prove()).toBe("unknown");

    const notes = log(session).filter(
      (entry) => entry.kind === "auto" && entry.action === "budget",
    );
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain("3 steps");
    // It stopped where it said it did.
    const calls = log(session).filter((entry) => entry.kind === "tool_call");
    expect(calls).toHaveLength(3);
  });

  test("a turn that calls nothing is asked to carry on", async () => {
    const { session, prove } = await agent([
      turn("thinking about it"),
      turn("thinking some more"),
      turn("proving", [{ name: "goal_check", arguments: { gid: "g1" } }]),
    ]);
    expect(await prove()).toBe("verified");

    // Two silent turns did not end the run: the third one settled it.
    const said = JSON.stringify(log(session).filter((entry) => entry.kind === "message"));
    expect(said).toContain("The run is not settled");
    const calls = log(session).filter((entry) => entry.kind === "tool_call");
    expect(calls.map((entry) => entry.tool)).toEqual(["check"]);
  });

  test("run_give_up ends the run and says why", async () => {
    const { session, prove } = await agent([
      turn("done here", [{ name: "run_give_up", arguments: { reason: "the cut goes nowhere" } }]),
      turn("more", [{ name: "run_status", arguments: {} }]),
    ]);
    expect(await prove()).toBe("unknown");

    // It is recorded the way every other move is, and nothing after it ran.
    const calls = log(session).filter((entry) => entry.kind === "tool_call");
    expect(calls.map((entry) => entry.tool)).toEqual(["give_up"]);
    expect(JSON.stringify(calls[0])).toContain("the cut goes nowhere");
  });

  test("a tool that throws is an error the model can read, not a dead run", async () => {
    const { session, prove } = await agent([
      turn("looking", [{ name: "goal_show", arguments: { ref: "g9" } }]),
      turn("proving", [{ name: "goal_check", arguments: { gid: "g1" } }]),
    ]);
    expect(await prove()).toBe("verified");

    const said = JSON.stringify(log(session).filter((entry) => entry.kind === "message"));
    expect(said).toContain("no goal g9");
  });
});
