// Running the agent, by hand or, with -p, without a terminal.
//
// The same session directory an example writes, produced by a model instead of
// a script: the trajectory, the store, and the certificate when it earns one.
//
// Pi draws the run, in its TUI, which is also where a model is logged into and
// picked. Nothing is drawn here, and what the screen shows is in the trajectory
// too.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { readArgs, readCount, readPair, tryOrExit } from "../core/args.ts";
import { repoRoot } from "../core/config.ts";
import { boundRun, closeRun, stamp, startRun } from "../core/run.ts";
import { createProofAssistant, createServices } from "./agent.ts";
import type { Limits } from "./budget.ts";
import { chooseModel, listAvailableModels, THINKING_LEVELS } from "./model.ts";
import { PrintMode } from "./print-mode.ts";

const USAGE = `usage: bun run agent [options] <src.ll> <tgt.ll> [<directory>]

  -m, --model <ref>      provider/id, a bare id, or either with :<level>
      --provider <id>    which provider a bare id meant
      --thinking <level> ${THINKING_LEVELS.join(", ")}
      --list-models      what this machine can reach, then stop
      --pause            open with the opening turn unsent, for enter to send
  -p, --print            run with no TUI, printing each message and how it went
      --max-steps <n>    stop after n turns, unbounded by default
      --max-seconds <n>  stop after n seconds, unbounded by default
  -h, --help

The model, and the key it needs, are Pi's: /login and /model inside the TUI
set them up, and --model overrides the choice for one run.`;

const NOTHING_AVAILABLE = `Error: no model this machine can reach. Any one of these gives it one:
  bun run agent <src.ll> <tgt.ll>   then /login inside the TUI
  export ANTHROPIC_API_KEY=...      or the variable your provider uses
  .pi/extensions/                   to declare a local server of your own`;

const started = Date.now();
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
// Both programs, and the model, before anything is created, so a command line
// naming a file or a model that is not there leaves nothing behind it.
const { src, tgt, where } = readPair(flags.rest);

const dir = where ?? join(repoRoot(), "sessions", `agent-${stamp()}`);
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
      pi.on("session_shutdown", () => {
        announce = undefined;
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
const { session, config } = await startRun({ src, tgt, dir, eager: true });
if (flags.print) console.log(`  ${dir}`);

let summary: string | undefined;
let closed: string | undefined;

// The start check can end the run before the model is asked for anything:
// either verdict settles it. No search is left, so the run is concluded with
// no assistant to build and no screen to open.
if (session.verdict !== "unknown") {
  finishRun();
  if (summary) process.stdout.write(summary);
  process.exit(0);
}

const agent = await createProofAssistant({
  session,
  services,
  choice,
  toolchain: config.toolchain,
  limits: flags.limits,
  onSettled: () => finishRun(),
});

// The certificate is earned the moment the tree settles, which under the TUI
// is long before the process ends, so the run is concluded there and the
// summary is held until the terminal is the shell's again.
process.on("exit", () => {
  finishRun();
  if (summary) process.stdout.write(`${summary}\n`);
});

// Without a terminal, the run prints rather than draws, and --max-seconds
// bounds the whole process, a turn in flight included.
if (flags.print) {
  if (flags.limits.maxSeconds) boundRun(flags.limits.maxSeconds * 1000, started, finishRun);
  await new PrintMode(agent).run();
  process.exit(0);
}

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
interface Flags {
  model?: string;
  provider?: string;
  thinking?: ThinkingLevel;
  limits: Limits;
  listModels?: boolean;
  pause?: boolean;
  print?: boolean;
  help?: boolean;
  /** The positional arguments, in the order they were given. */
  rest: string[];
}

/** The agent's command line. */
function parseArgs(args: string[]): Flags {
  const flags: Flags = { limits: {}, rest: [] };
  flags.rest = readArgs(args, (arg, value) => {
    if (arg === "-m" || arg === "--model") flags.model = value();
    else if (arg === "--provider") flags.provider = value();
    else if (arg === "--thinking") flags.thinking = parseThinkingLevel(value());
    else if (arg === "--list-models") flags.listModels = true;
    else if (arg === "--pause") flags.pause = true;
    else if (arg === "-p" || arg === "--print") flags.print = true;
    else if (arg === "--max-steps") flags.limits.maxSteps = readCount(arg, value());
    else if (arg === "--max-seconds") flags.limits.maxSeconds = readCount(arg, value());
    else if (arg === "-h" || arg === "--help") flags.help = true;
    else return false;
    return true;
  });
  if (flags.print && flags.pause) throw new Error("--pause needs the TUI, which -p runs without");
  return flags;
}

function parseThinkingLevel(level: string): ThinkingLevel {
  if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
    throw new Error(`--thinking must be one of ${THINKING_LEVELS.join(", ")}`);
  }
  return level as ThinkingLevel;
}

/**
 * Close the run and say how it went, once for each verdict it reaches. The
 * TUI quits through `process.exit`, and a run stopped by its budget can still
 * settle there, so this has to be safe to call from either end.
 */
function finishRun(): void {
  if (closed === session.verdict) return;
  const { outcome, lines } = closeRun(session, started);
  closed = outcome;
  const settled = outcome !== "unknown";
  summary = `${lines.map((line) => `  ${line}`).join("\n")}\n`;
  // A verdict is news where the run is being watched; the shell gets it too,
  // once the screen is the shell's again.
  announce?.(lines.join("\n"), settled ? "info" : "warning");
}
