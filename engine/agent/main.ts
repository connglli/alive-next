// Running the agent by hand.
//
// The same session directory an example writes, produced by a model instead of
// a script: the trajectory, the store, and the certificate when it earns one.
//
// Pi draws the run, in its TUI, which is also where a model is logged into and
// picked. Nothing is drawn here, and what the screen shows is in the trajectory
// too.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { certify } from "../cert/main.ts";
import { loadConfig, repoRoot } from "../core/config.ts";
import { AliveTv } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import { Llubi } from "../core/drivers/llubi.ts";
import { Session } from "../core/session.ts";
import { timeoutsFrom } from "../core/state/steps.ts";
import { Toolchain } from "../core/toolchain.ts";
import { createAgent, createServices } from "./agent.ts";
import type { Limits } from "./budget.ts";
import { chooseModel, listAvailableModels, THINKING_LEVELS } from "./model.ts";

const USAGE = `usage: bun run agent [options] <src.ll> <tgt.ll> [<directory>]

  -m, --model <ref>      provider/id, a bare id, or either with :<level>
      --provider <id>    which provider a bare id meant
      --thinking <level> ${THINKING_LEVELS.join(", ")}
      --list-models      what this machine can reach, then stop
      --pause            open with the opening turn unsent, for enter to send
      --max-steps <n>    stop after n turns, unbounded by default
      --max-seconds <n>  stop after n seconds, unbounded by default
  -h, --help

The model, and the key it needs, are Pi's: /login and /model inside the TUI
set them up, and --model overrides the choice for one run.`;

const NOTHING_AVAILABLE = `Error: no model this machine can reach. Any one of these gives it one:
  bun run agent <src.ll> <tgt.ll>   then /login inside the TUI
  export ANTHROPIC_API_KEY=...      or the variable your provider uses
  .pi/extensions/                   to declare a local server of your own`;

const flags = tryOrExit(() => parseArgs(process.argv.slice(2)));
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

if (flags.listModels) {
  const { modelRuntime } = await createServices({ cwd: repoRoot() });
  const available = await listAvailableModels(modelRuntime);
  console.log(available.length ? available.join("\n") : NOTHING_AVAILABLE);
  process.exit(available.length ? 0 : 1);
}

// A run is one pair, so both sides are named or there is nothing to prove.
const [srcPath, tgtPath, where] = flags.rest;
if (!srcPath || !tgtPath) {
  const given = flags.rest.length === 0 ? "no program" : "only one program";
  exitWithError(`${given} given, and a run proves one against another`);
}

// Both programs, and the model, before anything is created, so a command line
// naming a file or a model that is not there leaves nothing behind it.
const src = readProgram(srcPath);
const tgt = readProgram(tgtPath);

const config = loadConfig();
const timeouts = timeoutsFrom(config.timeouts);
const toolchain = new Toolchain(config.toolchain);
const built = await toolchain.insist();

const dir = where ?? join(repoRoot(), "sessions", `agent-${timestamp()}`);
const scratch = join(dir, "scratch");

// What a settled run says, on the screen the run is being watched on. Pi's
// TUI outlives the loop, so a verdict reached there would otherwise be visible
// only after quitting, and the certificate is the thing a run is for.
let announce: ((line: string, kind: "info" | "warning") => void) | undefined;

// Pi's services, once. A project declares its providers in extensions, which
// are known only once they are loaded, so the loading happens here and the
// runtime the model is chosen from is the one that will stream it.
const services = await createServices({
  cwd: scratch,
  extensionFactories: [
    (pi) => {
      pi.on("session_start", (_event, ctx) => {
        announce = (line, kind) => ctx.ui.notify(line, kind);
        // Pi fires this once its screen is up, which is the first moment there
        // is an editor to put a paused run's opening turn in.
        if (flags.pause) ctx.ui.setEditorText(agent.task);
      });
    },
  ],
});
const choice = tryOrExit(() =>
  chooseModel(services.modelRuntime, {
    model: flags.model,
    provider: flags.provider,
    thinking: flags.thinking,
  }),
);

mkdirSync(scratch, { recursive: true });
const session = await Session.start({
  dir,
  src,
  tgt,
  llops: new Llops(toolchain.path("llops")),
  checker: new AliveTv(toolchain.path("alive-tv"), timeouts.alive2Ms),
  interp: new Llubi(toolchain.path("llubi")),
  timeouts,
  config,
  toolchain: built,
});

const started = Date.now();
let summary: string | undefined;
const agent = await createAgent({
  session,
  services,
  choice,
  limits: flags.limits,
  onSettled: () => finishRun(true),
});

// The certificate is earned the moment the tree settles, which under the TUI
// is long before the process ends, so the run is concluded there and the
// summary is held until the terminal is the shell's again.
process.on("exit", () => {
  finishRun();
  if (summary) process.stdout.write(summary);
});

// A run sends its opening turn and starts working. `--pause` holds that turn
// back in the editor instead, where enter sends it, so a model can be picked,
// a thinking level set or the pair read before any of it is paid for.
await new InteractiveMode(agent.runtime, {
  initialMessage: flags.pause ? undefined : agent.task,
}).run();

/**
 * Say what is wrong with the command line and stop. A mistyped flag is the
 * user's mistake rather than the program's, so it reads as one sentence and
 * not as a stack that points into this file. What it carries beyond that
 * sentence is nothing: `--help` is where the usage is, and a model that does
 * not exist is better answered by naming what does.
 */
function exitWithError(wrong: string): never {
  console.error(`Error: ${wrong}`);
  process.exit(2);
}

function tryOrExit<T>(reading: () => T): T {
  try {
    return reading();
  } catch (wrong) {
    return exitWithError(wrong instanceof Error ? wrong.message : String(wrong));
  }
}

/** A program the command line named, or a sentence saying why there is none. */
function readProgram(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (wrong) {
    return exitWithError(`cannot read ${path}: ${(wrong as NodeJS.ErrnoException).code ?? wrong}`);
  }
}

interface Flags {
  model?: string;
  provider?: string;
  thinking?: ThinkingLevel;
  limits: Limits;
  listModels?: boolean;
  pause?: boolean;
  help?: boolean;
  /** The positional arguments, in the order they were given. */
  rest: string[];
}

/**
 * The command line. Throws on a flag it does not know rather than treating it
 * as a file, since a mistyped flag would otherwise become a missing pair.
 */
function parseArgs(args: string[]): Flags {
  const flags: Flags = { limits: {}, rest: [] };
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    const value = (): string => {
      const next = args[++at];
      if (next === undefined) throw new Error(`${arg} wants a value`);
      return next;
    };
    if (arg === "-m" || arg === "--model") flags.model = value();
    else if (arg === "--provider") flags.provider = value();
    else if (arg === "--thinking") flags.thinking = parseThinkingLevel(value());
    else if (arg === "--list-models") flags.listModels = true;
    else if (arg === "--pause") flags.pause = true;
    else if (arg === "--max-steps") flags.limits.maxSteps = count(arg, value());
    else if (arg === "--max-seconds") flags.limits.maxSeconds = count(arg, value());
    else if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg.startsWith("-")) throw new Error(`no such option ${arg}`);
    else flags.rest.push(arg);
  }
  return flags;
}

/** A count a flag carries, which is whole and above zero or it bounds nothing. */
function count(flag: string, given: string): number {
  const value = Number(given);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a whole number above zero, not ${given}`);
  }
  return value;
}

function parseThinkingLevel(level: string): ThinkingLevel {
  if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
    throw new Error(`--thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return level as ThinkingLevel;
}

/**
 * Close the run and say how it went, once however often it is asked. The TUI
 * quits through `process.exit`, and a run can be abandoned before it settles,
 * so this has to be safe to call from either end.
 *
 * `watched` says which end called: only the loop stopping is watched, and only
 * then is there a screen to say it on. Pi invalidates the context an extension
 * captured as it tears the session down, so a run abandoned before it settled
 * is concluded when saying anything on screen would throw rather than draw.
 */
function finishRun(watched = false): void {
  if (summary !== undefined) return;
  const outcome = session.finish();
  const goals = [...session.tree.goals.values()]
    .map((goal) => `${goal.id} ${goal.status}`)
    .join(", ");
  const settled = outcome !== "unknown";
  const lines = [`${outcome} in ${Date.now() - started}ms: ${goals}`];
  if (settled) lines.push(certify(dir, join(dir, "certificate")));
  summary = `${lines.map((line) => `  ${line}`).join("\n")}\n`;
  // A verdict is news where the run is being watched; the shell gets it too,
  // once the screen is the shell's again.
  if (watched) announce?.(lines.join("\n"), settled ? "info" : "warning");
}

/** A directory name that sorts by when it was made. */
function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}
