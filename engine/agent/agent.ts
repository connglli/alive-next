// The model in front of the engine: one Pi session driving one of ours.
//
// Everything verification-critical is below this file. What is here is the
// wiring: which tools exist, what the model is told, where its shell works,
// what stops the loop, and how what it did reaches the trajectory. A bug here
// costs tokens and produces no proof; it cannot produce a wrong one.
//
// Pi holds the message history and compacts it. The trajectory stays our
// record, because the goal tree is derived from it, and a second persisted
// history would be a cache to keep in step.
import { join } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Config } from "../core/config.ts";
import type { Session } from "../core/session.ts";
import { Budget } from "./budget.ts";
import { describedProvider, resolveModel } from "./model.ts";
import { CARRY_ON_INSTRUCTION, SYSTEM_INSTRUCTION, TASK_INSTRUCTION } from "./prompt.ts";
import { BUILTIN, type Stop, tools } from "./tools/index.ts";

export interface AgentOptions {
  /** The proof to drive, already started on the pair. */
  session: Session;
  config: Config;
  /** Where the shell and the file tools work, which is not the store. */
  scratch: string;
}

export interface Agent {
  /** Pi's session, for a caller that wants to watch or steer it. */
  pi: AgentSession;
  /** Work until the run settles or the budget is spent, and say which. */
  prove(): Promise<"verified" | "counterexample" | "unknown">;
}

/**
 * Assemble the agent. The tool surface is stated here rather than discovered:
 * `noTools` drops Pi's defaults, the allowlist names every tool that exists,
 * and the resource loader is told to read nothing from the machine, so what a
 * run can do is what this file says and not what is installed beside it.
 */
export async function agentFor(options: AgentOptions): Promise<Agent> {
  const { session, config, scratch } = options;
  const stop: Stop = {};
  const surface = tools(session, stop);
  const provider = describedProvider(config.model);
  const budget = new Budget(config.budget);

  const loader = new DefaultResourceLoader({
    cwd: scratch,
    agentDir: join(scratch, "pi"),
    systemPrompt: SYSTEM_INSTRUCTION,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        // A local endpoint is ours to describe; a provider Pi knows brings
        // its own catalogue and credentials.
        if (provider) pi.registerProvider(provider);
      },
    ],
  });
  await loader.reload();

  const { session: pi } = await createAgentSession({
    cwd: scratch,
    agentDir: join(scratch, "pi"),
    model: resolveModel(config.model).model,
    thinkingLevel: config.model.thinkingLevel ?? "medium",
    noTools: "all",
    tools: [...BUILTIN, ...surface.map((tool) => tool.name)],
    customTools: surface,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(scratch),
  });

  // Our tools mutate one goal tree, so a batch holding a commit and a split
  // would answer differently depending on which ran first.
  pi.agent.toolExecution = "sequential";

  // Three things end a run: the tree settled, the model said it was done, or
  // the budget ran out. Pi honours a tool's terminate hint only when every
  // result in the batch carries it, so the first two are tested again here,
  // where a mixed batch cannot hide them. The budget is a property of the run
  // rather than of any result, so it lives only here.
  //
  // A turn that called nothing is none of the three. Pi's loop would stop
  // there, having nothing left to answer, so the run says what remains and
  // queues it as a follow-up, which is what its outer loop drains.
  pi.agent.shouldStopAfterTurn = async (turn) => {
    if (session.verdict !== "unknown") return true;
    if (stop.gaveUp) return true;
    const spent = budget.spend();
    if (spent) {
      session.note("budget", { stopped: spent, spent: budget.spent });
      return true;
    }
    const called = turn.message.content.some((part) => part.type === "toolCall");
    if (!called) await pi.followUp(CARRY_ON_INSTRUCTION);
    return false;
  };

  // What the model said, and what the framework did to its history, both
  // reach the trajectory. Its tool calls are already there: every one of ours
  // writes itself, and Pi's own arrive inside the assistant message.
  pi.subscribe((event) => {
    if (event.type === "message_end") session.message(event.message);
    if (event.type === "compaction_end") {
      session.note("compaction", { reason: event.reason, aborted: event.aborted });
    }
  });

  return {
    pi,
    prove: async () => {
      await pi.prompt(TASK_INSTRUCTION);
      return session.verdict;
    },
  };
}
