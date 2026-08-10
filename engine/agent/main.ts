// Running the agent by hand: `bun run agent <src.ll> <tgt.ll> [<directory>]`.
//
// The same session directory an example writes, produced by a model instead of
// a script: the trajectory, the store, and the certificate when it earns one.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { certify } from "../cert/main.ts";
import { loadConfig, repoRoot } from "../core/config.ts";
import { AliveTv } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import { Llubi } from "../core/drivers/llubi.ts";
import { Session } from "../core/session.ts";
import { timeoutsFrom } from "../core/state/steps.ts";
import { Toolchain } from "../core/toolchain.ts";
import { agentFor } from "./agent.ts";

const [srcPath, tgtPath, where] = process.argv.slice(2);
if (!srcPath || !tgtPath) {
  console.error("usage: bun run agent <src.ll> <tgt.ll> [<directory>]");
  process.exit(2);
}

const config = loadConfig();
const timeouts = timeoutsFrom(config.timeouts);
const toolchain = new Toolchain(config.toolchain);
const built = await toolchain.insist();

const dir = where ?? join(repoRoot(), "sessions", `agent-${stamp()}`);
const scratch = join(dir, "scratch");
mkdirSync(scratch, { recursive: true });

const session = await Session.start({
  dir,
  src: readFileSync(srcPath, "utf8"),
  tgt: readFileSync(tgtPath, "utf8"),
  llops: new Llops(toolchain.path("llops")),
  checker: new AliveTv(toolchain.path("alive-tv"), timeouts.alive2Ms),
  interp: new Llubi(toolchain.path("llubi")),
  timeouts,
  config,
  toolchain: built,
  versions: { model: `${config.model.provider}/${config.model.id}` },
});

console.log(
  `${srcPath} against ${tgtPath}\n  ${dir}\n  ${config.model.provider}/${config.model.id}`,
);
const agent = await agentFor({ session, config, scratch });
watch(agent.pi);
const started = Date.now();
const outcome = await agent.prove();
session.finish();

const goals = [...session.tree.goals.values()]
  .map((goal) => `${goal.id} ${goal.status}`)
  .join(", ");
console.log(`  ${outcome} in ${Date.now() - started}ms: ${goals}`);
if (outcome !== "unknown") console.log(`  ${certify(dir, join(dir, "certificate"))}`);
process.exit(outcome === "unknown" ? 1 : 0);

/** A directory name that sorts by when it was made. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}

/**
 * The run as it happens. `>` is the model, whether it is speaking or calling;
 * `<` is what the run says back to it; an indented line is what a call
 * answered with. Watching is this file's business rather than the agent's,
 * which stays quiet so that a caller with a screen of its own can draw the
 * same events differently. Everything printed here is in the trajectory too.
 */
function watch(pi: AgentSession): void {
  let speaking = false;
  const say = (line: string) => {
    if (speaking) process.stdout.write("\n");
    speaking = false;
    process.stdout.write(`${line}\n`);
  };
  pi.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      // A message often opens with blank lines, and an arrow on a line of
      // its own says nothing, so the marker waits for the first real word.
      let delta = event.assistantMessageEvent.delta;
      if (!speaking) {
        delta = delta.replace(/^\s+/, "");
        if (delta === "") return;
        process.stdout.write("\n> ");
        speaking = true;
      }
      process.stdout.write(delta.replace(/\n/g, "\n  "));
      return;
    }
    if (event.type === "message_end") {
      // A message that ends while it is still being written needs the line
      // closed, or whatever prints next continues the model's sentence.
      if (speaking) {
        speaking = false;
        process.stdout.write("\n");
      }
      // What the run says back to the model: the opening task, and the turn
      // that asks it to carry on after it has fallen silent. Without these a
      // watcher sees the model answering questions nobody asked.
      if (event.message.role === "user") say(`\n< ${trim(text(event.message.content), 200)}`);
    }
    if (event.type === "tool_execution_start") {
      say(`\n> ${event.toolName} ${trim(JSON.stringify(event.args ?? {}), 100)}`);
    }
    if (event.type === "tool_execution_end") say(`  ${said(event.result)}`);
  });
}

/** How a call came back: the first word, and the first thing it said. */
function said(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const lines = text(content)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return trim(lines.slice(0, 2).join(": "), 160);
}

function trim(said: string, at: number): string {
  return said.length > at ? `${said.slice(0, at)}...` : said;
}

/** The words out of a message's content, whatever else it carries. */
function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      (part as { type?: string }).type === "text" ? ((part as { text?: string }).text ?? "") : "",
    )
    .join("");
}
