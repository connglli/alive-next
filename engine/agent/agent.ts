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
//
// What is built is a session runtime rather than a bare session, because that
// is what Pi's own run modes take, so a caller can draw the run with Pi's TUI
// or with nothing at all. Nothing here draws anything.
import type {
  AgentSessionServices,
  InlineExtension,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { repoRoot } from "../core/config.ts";
import type { Session } from "../core/session.ts";
import { Budget, type Limits } from "./budget.ts";
import { type ChosenModel, createResourceOptions } from "./model.ts";
import { CARRY_ON_INSTRUCTION, SYSTEM_INSTRUCTION, TASK_INSTRUCTION } from "./prompt.ts";
import {
  type AssistantStop,
  createProofAssistantTools,
  createSandboxTools,
} from "./tools/index.ts";

export interface ServicesOptions {
  /** Where the shell and the file tools work: a run's scratch directory. */
  cwd: string;
  /** The project Pi reads its project layer from, which is the repository. */
  project?: string;
  /** Pi's own directory, holding the machine's settings and credentials. */
  agentDir?: string;
  /** An already built runtime, for a caller that has one. */
  models?: ModelRuntime;
  /** Extensions a caller supplies itself, which a screen uses to draw with. */
  extensionFactories?: InlineExtension[];
}

/**
 * Pi's services for one run: its models and credentials, this project's
 * settings, and the resources a run is allowed to load.
 *
 * Built here rather than inside `createAgent`, because a caller has to choose a
 * model before a run starts and the providers a project declares are known
 * only once its extensions have been loaded. Loading them is what this does,
 * so it happens once and the runtime a model is chosen from is the one that
 * streams it.
 *
 * The project layer is read from the repository rather than from `cwd`, which
 * is where Pi would look for it, because a run's `cwd` is its scratch
 * directory and not where the project is.
 */
export function createServices(options: ServicesOptions): Promise<AgentSessionServices> {
  const project = options.project ?? repoRoot();
  const agentDir = options.agentDir ?? getAgentDir();
  return createAgentSessionServices({
    cwd: options.cwd,
    agentDir,
    modelRuntime: options.models,
    settingsManager: SettingsManager.create(project, agentDir),
    resourceLoaderOptions: createResourceOptions(
      project,
      SYSTEM_INSTRUCTION,
      options.extensionFactories,
    ),
  });
}

export interface ProofAssistantOpts {
  /** The proof to drive, already started on the pair. */
  session: Session;
  /** What the run may spend, or nothing, which lets it run until it settles. */
  limits?: Limits;
  /** Pi's services, and the model this run asked for, if it asked for one. */
  services: AgentSessionServices;
  /** Where the toolchain the search's shell may run was built. */
  toolchain?: string;
  choice?: ChosenModel;
  /**
   * Called when the loop stops, whichever of the three things stopped it. A
   * caller that outlives the loop, which anything holding a screen does, has
   * work that belongs to the moment the run ended rather than to its own exit.
   */
  onSettled?: () => void;
}

export interface ProofAssistant {
  /** Pi's session, for a caller that wants to watch or steer it. */
  pi: AgentSession;
  /** What Pi's run modes take, for a caller that wants one to draw the run. */
  runtime: AgentSessionRuntime;
  /** The opening turn, which every way of running this one sends. */
  task: string;
  /**
   * Work until the run settles or the budget is spent, and say which, for a
   * caller that drives the loop itself rather than watching Pi draw it.
   */
  prove(): Promise<"verified" | "counterexample" | "unknown">;
}

/**
 * Assemble the agent. The tool surface is stated here rather than discovered:
 * `noTools` drops Pi's defaults, the allowlist names every tool that exists,
 * and the resource loader is told to read nothing from the machine, so what a
 * run can do is what this file says and not what is installed beside it. The
 * names Pi's own built-ins had are in the list only as our sandbox tools, each
 * confined to the run's scratch directory (tools/sandbox.ts).
 *
 * A run with no model is assembled all the same, because Pi's TUI is where a
 * machine with none is set up. What that costs is the first turn, which fails
 * saying so.
 */
export async function createProofAssistant(options: ProofAssistantOpts): Promise<ProofAssistant> {
  const { session, limits, services, choice, onSettled } = options;
  const stop: AssistantStop = {};
  const surface = createProofAssistantTools(session, stop);
  const sandbox = createSandboxTools(services.cwd, options.toolchain);
  const budget = new Budget(limits);

  // The services are the caller's, already loaded, and one run works in one
  // directory, so every session this runtime makes is bound to the same ones.
  // Pi would build fresh services per session, which is what a host that lets
  // the working directory change needs and this one does not.
  const build: CreateAgentSessionRuntimeFactory = async (target) => {
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: target.sessionManager,
      sessionStartEvent: target.sessionStartEvent,
      model: choice?.model,
      thinkingLevel: choice?.thinkingLevel,
      noTools: "all",
      tools: [...sandbox, ...surface].map((tool) => tool.name),
      customTools: [...sandbox, ...surface],
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(build, {
    cwd: services.cwd,
    agentDir: services.agentDir,
    sessionManager: SessionManager.inMemory(services.cwd),
  });
  const pi = runtime.session;

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
    const over = (): boolean => {
      if (session.verdict !== "unknown") return true;
      if (stop.gaveUp) return true;
      const spent = budget.spend();
      if (!spent) return false;
      session.note("budget", { stopped: spent, spent: budget.spent });
      return true;
    };
    if (over()) {
      onSettled?.();
      return true;
    }
    const called = turn.message.content.some((part) => part.type === "toolCall");
    if (!called) await pi.followUp(CARRY_ON_INSTRUCTION);
    return false;
  };

  // What the model said, and what the framework did to its history, both
  // reach the trajectory. Its tool calls are already there: every one of ours
  // writes itself, and Pi's own arrive inside the assistant message. So does
  // the model that said it, which is why no separate record names one: the
  // TUI can switch models mid-run, and a second copy would go stale.
  pi.subscribe((event) => {
    if (event.type === "message_end") session.message(event.message);
    if (event.type === "compaction_end") {
      session.note("compaction", { reason: event.reason, aborted: event.aborted });
    }
  });

  return {
    pi,
    runtime,
    task: TASK_INSTRUCTION,
    prove: async () => {
      await pi.prompt(TASK_INSTRUCTION);
      return session.verdict;
    },
  };
}
