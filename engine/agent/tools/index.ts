// The tool surface, as one list.
//
// Every tool delegates to one move of the session and formats what came back.
// It decides nothing: what a move answers with is the move's business, and is
// settled in core/session.ts, so a scripted caller and a model are told the
// same thing.
//
// A tool that fails throws, which Pi reports to the model as a tool error. A
// refused edit, a rejected commit and a failed check are not failures: they
// are what the run looks like, and they come back as ordinary results.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Session } from "../../core/session.ts";
import { createAbortTool } from "./abort.ts";
import { createAnalyzeTool } from "./analyze.ts";
import { createBeginTool } from "./begin.ts";
import { createCheckTool } from "./check.ts";
import { createCommitTool } from "./commit.ts";
import { createEditTool } from "./edit.ts";
import { createGiveUpTool } from "./give-up.ts";
import { createOptTool } from "./opt.ts";
import { createReportCexTool } from "./report-cex.ts";
import { createRevertTool } from "./revert.ts";
import { createSandboxTools, SANDBOX_TOOLS } from "./sandbox.ts";
import { createShowTool } from "./show.ts";
import { createSplitTool } from "./split.ts";
import { createStatusTool } from "./status.ts";
import { createStrengthenTool } from "./strengthen.ts";
import { createUnsplitTool } from "./unsplit.ts";

export { createSandboxTools, SANDBOX_TOOLS };

/**
 * Why a run is over, when it is not the goal tree that says so. The agent
 * loop reads this after every turn, and `run_give_up` is what writes it.
 */
export interface AssistantStop {
  gaveUp?: string;
}

/** Ours, in the order they are worth reading: look, decide, edit, cut, settle. */
export function createProofAssistantTools(
  session: Session,
  stop: AssistantStop = {},
): ToolDefinition[] {
  return [
    createStatusTool(session),
    createShowTool(session),
    createAnalyzeTool(session),
    createCheckTool(session),
    createBeginTool(session),
    createEditTool(session),
    createOptTool(session),
    createCommitTool(session),
    createAbortTool(session),
    createRevertTool(session),
    createSplitTool(session),
    createUnsplitTool(session),
    createStrengthenTool(session),
    createReportCexTool(session),
    createGiveUpTool(session, stop),
  ];
}

/** Every tool a run may call, which is what the allowlist has to say. */
export function listToolNames(session: Session): string[] {
  return [...SANDBOX_TOOLS, ...createProofAssistantTools(session).map((tool) => tool.name)];
}
