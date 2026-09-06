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
import { toolResultFrom } from "./format.ts";
import { createGiveUpTool } from "./give-up.ts";
import { createOptTool } from "./opt.ts";
import { createReportCexTool } from "./report-cex.ts";
import { createRevertTool } from "./revert.ts";
import { createRewriteTool } from "./rewrite.ts";
import { createRulesTool } from "./rules.ts";
import { createSandboxTools, SANDBOX_TOOLS } from "./sandbox.ts";
import { createShowTool } from "./show.ts";
import { createSplitTool } from "./split.ts";
import { createSplitPreviewTool } from "./split-preview.ts";
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
    createRulesTool(session),
    createRewriteTool(session),
    createBeginTool(session),
    createEditTool(session),
    createOptTool(session),
    createCommitTool(session),
    createAbortTool(session),
    createRevertTool(session),
    createSplitPreviewTool(session),
    createSplitTool(session),
    createUnsplitTool(session),
    createStrengthenTool(session),
    createReportCexTool(session),
    createGiveUpTool(session, stop),
  ].map((tool) => withErrorGuard(tool, session));
}

/**
 * Wrapping every proof tool here turns any thrown error into an ordinary
 * `refused` result so the model sees a `FAILURE` with the same shape as any
 * other refusal.
 */
function withErrorGuard(tool: ToolDefinition, session: Session): ToolDefinition {
  const orig = tool.execute as (...args: unknown[]) => Promise<unknown>;
  return {
    ...tool,
    execute: async (...args: unknown[]) => {
      try {
        return await orig(...args);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return toolResultFrom(session, false, `refused: ${msg}`, {
          error: msg,
        } as unknown as never);
      }
    },
  } as ToolDefinition;
}

/** Every tool a run may call, which is what the allowlist has to say. */
export function listToolNames(session: Session): string[] {
  return [...SANDBOX_TOOLS, ...createProofAssistantTools(session).map((tool) => tool.name)];
}
