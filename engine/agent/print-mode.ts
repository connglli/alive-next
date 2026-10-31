// A run without a terminal, as Pi's InteractiveMode is a run with one.
//
// The opening turn goes at once, and each message prints as it ends, under a
// line that says who did what, with its body indented by four spaces, so that
// no line of it reads as one of the run's own, which are indented by two: where
// the session is, and the verdict. Pi's own print mode prints the last reply
// alone or every event of the stream, and a run's log wants each message whole.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ProofAssistant } from "./agent.ts";

export class PrintMode {
  constructor(private readonly assistant: ProofAssistant) {}

  /** Work until the run ends, printing each message as it ends. */
  async run(): Promise<void> {
    this.assistant.pi.subscribe((event) => {
      if (event.type !== "message_end") return;
      for (const line of transcript(event.message)) console.log(line);
    });
    try {
      await this.assistant.prove();
    } catch (error) {
      console.log(`  stopped: ${(error as Error).message}`);
    }
  }
}

/** The lines a message prints as, or none for a kind of message this does not print. */
function transcript(message: AgentMessage): string[] {
  if (message.role === "user") return block("user says", textOf(message.content));
  if (message.role === "toolResult") {
    const how = message.isError ? "fails" : "answers";
    return block(`${message.toolName} ${how}`, textOf(message.content));
  }
  if (message.role !== "assistant") return [];
  const lines: string[] = [];
  for (const part of message.content) {
    if (part.type === "thinking" && part.thinking.trim()) {
      lines.push(...block("assistant thinks", part.thinking));
    } else if (part.type === "text" && part.text.trim()) {
      lines.push(...block("assistant says", part.text));
    } else if (part.type === "toolCall") {
      lines.push(...block(`assistant calls ${part.name}`, JSON.stringify(part.arguments)));
    }
  }
  if (message.errorMessage) lines.push(...block("assistant fails", message.errorMessage));
  return lines;
}

/** A header, then its body indented by four spaces. */
function block(header: string, body: string): string[] {
  const text = body.trimEnd();
  return [`${header}:`, ...(text ? text.split("\n").map((line) => `    ${line}`) : [])];
}

/** The text a message's content holds, with an image named by its type. */
function textOf(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[${part.mimeType}]`))
    .join("\n");
}
