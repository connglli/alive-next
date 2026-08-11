// The run as it happens, in plain text, for a pipe or a log.
//
// Pi's own print mode answers a question and stops, so it prints the last
// message once the run is over. A proof is not one question: it is a long
// series of turns whose interesting part is the moves, and whose last message
// is usually a tool call with nothing to say. So this streams the run instead,
// which is what a watcher of a long search needs.
//
// `>` is the model, whether it is speaking or calling; `<` is what the run
// says back to it; an indented line is what a call answered with. Everything
// printed here is in the trajectory too.
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function streamRun(pi: AgentSession, to: NodeJS.WritableStream = process.stdout): void {
  let speaking = false;
  const say = (line: string) => {
    if (speaking) to.write("\n");
    speaking = false;
    to.write(`${line}\n`);
  };
  pi.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      // A message often opens with blank lines, and an arrow on a line of
      // its own says nothing, so the marker waits for the first real word.
      let delta = event.assistantMessageEvent.delta;
      if (!speaking) {
        delta = delta.replace(/^\s+/, "");
        if (delta === "") return;
        to.write("\n> ");
        speaking = true;
      }
      to.write(delta.replace(/\n/g, "\n  "));
      return;
    }
    if (event.type === "message_end") {
      // A message that ends while it is still being written needs the line
      // closed, or whatever prints next continues the model's sentence.
      if (speaking) {
        speaking = false;
        to.write("\n");
      }
      // What the run says back to the model: the opening task, and the turn
      // that asks it to carry on after it has fallen silent. Without these a
      // watcher sees the model answering questions nobody asked.
      if (event.message.role === "user")
        say(`\n< ${truncate(extractText(event.message.content), 200)}`);
    }
    if (event.type === "tool_execution_start") {
      say(`\n> ${event.toolName} ${truncate(JSON.stringify(event.args ?? {}), 100)}`);
    }
    if (event.type === "tool_execution_end") say(`  ${summarizeToolResult(event.result)}`);
  });
}

/** How a call came back: the first word, and the first thing it said. */
function summarizeToolResult(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const lines = extractText(content)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return truncate(lines.slice(0, 2).join(": "), 160);
}

function truncate(line: string, at: number): string {
  return line.length > at ? `${line.slice(0, at)}...` : line;
}

/** The words out of a message's content, whatever else it carries. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      (part as { type?: string }).type === "text" ? ((part as { text?: string }).text ?? "") : "",
    )
    .join("");
}
