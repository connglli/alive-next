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
import { abortTool } from "./abort.ts";
import { analyzeTool } from "./analyze.ts";
import { beginTool } from "./begin.ts";
import { checkTool } from "./check.ts";
import { commitTool } from "./commit.ts";
import { editTool } from "./edit.ts";
import { reportCexTool } from "./report-cex.ts";
import { revertTool } from "./revert.ts";
import { showTool } from "./show.ts";
import { splitTool } from "./split.ts";
import { statusTool } from "./status.ts";
import { strengthenTool } from "./strengthen.ts";
import { unsplitTool } from "./unsplit.ts";

/** Ours, in the order they are worth reading: look, decide, edit, cut, settle. */
export function tools(session: Session): ToolDefinition[] {
  return [
    statusTool(session),
    showTool(session),
    analyzeTool(session),
    checkTool(session),
    beginTool(session),
    editTool(session),
    commitTool(session),
    abortTool(session),
    revertTool(session),
    splitTool(session),
    unsplitTool(session),
    strengthenTool(session),
    reportCexTool(session),
  ];
}

/** Pi's own tools that stay, which serve the counterexample search. */
export const BUILTIN = ["bash", "read", "write", "grep"];

/** Every tool a run may call, which is what the allowlist has to say. */
export function toolNames(session: Session): string[] {
  return [...BUILTIN, ...tools(session).map((tool) => tool.name)];
}
