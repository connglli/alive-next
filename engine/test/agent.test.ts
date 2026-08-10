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
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { agentFor } from "../agent/agent.ts";
import { Budget } from "../agent/budget.ts";
import { loadConfig } from "../core/config.ts";
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
  const config = { ...loadConfig(), budget: { maxSteps } };
  const built = await agentFor({ session, config, scratch: join(dir, "scratch") });
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
      turn("looking", [{ name: "status", arguments: {} }]),
      turn("proving", [{ name: "check", arguments: { gid: "g1" } }]),
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

  test("a verdict ends the run, whatever the model meant to do next", async () => {
    const { session, prove } = await agent([
      turn("proving", [{ name: "check", arguments: { gid: "g1" } }]),
      turn("still going", [{ name: "status", arguments: {} }]),
    ]);
    expect(await prove()).toBe("verified");

    // The second turn never happened: the tool that settled the root said so.
    const calls = log(session).filter((entry) => entry.kind === "tool_call");
    expect(calls.map((entry) => entry.tool)).toEqual(["check"]);
    expect(session.verdict).toBe("verified");
  });

  test("a budget stops a model going in circles, and says so", async () => {
    const going = Array.from({ length: 10 }, () =>
      turn("again", [{ name: "status", arguments: {} }]),
    );
    const { session, prove } = await agent(going, 3);
    expect(await prove()).toBe("unknown");

    const notes = log(session).filter((entry) => entry.kind === "auto");
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
      turn("proving", [{ name: "check", arguments: { gid: "g1" } }]),
    ]);
    expect(await prove()).toBe("verified");

    // Two silent turns did not end the run: the third one settled it.
    const said = JSON.stringify(log(session).filter((entry) => entry.kind === "message"));
    expect(said).toContain("The run is not settled");
    const calls = log(session).filter((entry) => entry.kind === "tool_call");
    expect(calls.map((entry) => entry.tool)).toEqual(["check"]);
  });

  test("give_up ends the run and says why", async () => {
    const { session, prove } = await agent([
      turn("done here", [{ name: "give_up", arguments: { reason: "the cut goes nowhere" } }]),
      turn("more", [{ name: "status", arguments: {} }]),
    ]);
    expect(await prove()).toBe("unknown");

    // It is recorded the way every other move is, and nothing after it ran.
    const calls = log(session).filter((entry) => entry.kind === "tool_call");
    expect(calls.map((entry) => entry.tool)).toEqual(["give_up"]);
    expect(JSON.stringify(calls[0])).toContain("the cut goes nowhere");
  });

  test("a tool that throws is an error the model can read, not a dead run", async () => {
    const { session, prove } = await agent([
      turn("looking", [{ name: "show", arguments: { ref: "g9" } }]),
      turn("proving", [{ name: "check", arguments: { gid: "g1" } }]),
    ]);
    expect(await prove()).toBe("verified");

    const said = JSON.stringify(log(session).filter((entry) => entry.kind === "message"));
    expect(said).toContain("no goal g9");
  });
});
