// What a tool answers with, in the words the model reads.
//
// Two rules hold across every tool. A program appears as text only where the
// next move has to name values inside it, which is opening a transaction and
// editing one; everywhere else a program is named by its id and `goal_show` is how
// the text is asked for. And a move that changed where the run stands says so,
// because the model sees nothing between calls but what it is handed.
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CheckOutcome, CheckResult } from "../../core/drivers/alive2.ts";
import type { OutlineParam } from "../../core/drivers/llops.ts";
import { type GoalStanding, type Session, standings } from "../../core/session.ts";
import type { Timeouts } from "../../core/state/steps.ts";
import type { Effect, Hash } from "../../core/state/trajectory.ts";

/**
 * A tool's answer: what the model reads, and the result itself for the log.
 *
 * The first word says whether the move did what it was asked to do. A refused
 * edit, a rejected commit and a check that did not prove are all FAILURE, not
 * because anything went wrong but because the run did not advance, and that is
 * the thing a reader scanning its own history needs to see at a glance. What
 * follows says why, which is what it does next from.
 */
export function toolResult(
  ok: boolean,
  text: string,
  details: unknown = {},
): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: `${ok ? "SUCCESS" : "FAILURE"}\n\n${text}` }], details };
}

/**
 * The answer to a move that may have changed the run, which is where the tree
 * belongs: a model has no state between calls but what it is handed, and the
 * goal it works on next is chosen from what the last move left open. A move
 * that changed nothing, and every refusal, carries no effects and so no tree,
 * because repeating a picture the caller already has is how a context window
 * fills with nothing.
 *
 * A verdict ends the run here as well. Pi stops after a batch whose every
 * result says so, and the loop repeats the test after the turn, since a batch
 * that mixes them would carry on.
 */
export function toolResultFrom(
  session: Session,
  ok: boolean,
  text: string,
  details: unknown,
  parts: string[] = [],
): AgentToolResult<unknown> {
  const moved = ((details as { effects?: unknown[] }).effects ?? []).length > 0;
  const settled = session.verdict !== "unknown";
  const said = [
    text,
    settled ? `the root is ${session.verdict === "verified" ? "verified" : "refuted"}` : "",
    ...parts,
    moved ? formatSection("Goal tree", formatGoalTree(session, standings(session.tree))) : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return { ...toolResult(ok, said, details), ...(settled ? { terminate: true } : {}) };
}

/**
 * What one query may spend, on one line. A budget is not a detail of the machine:
 * it is what makes one move worth trying and another not, so it is read where
 * the tree is read rather than found out by running out of it.
 */
export function formatBudgets(budgets: Timeouts): string {
  return [
    `budgets per query: a check ${budgets.checkDefaultMs}ms by default and at most ${budgets.checkCapMs}ms`,
    `a commit ${budgets.alive2Ms}ms`,
    `the check after a step ${budgets.eagerCheckMs}ms`,
  ].join(", ");
}

/** A checker's answer in the words a result uses. */
export function outcomeWord(outcome: CheckOutcome): string {
  const words = {
    correct: "proved",
    incorrect: "refuted",
    unknown: "not settled",
    error: "not checked",
  };
  return words[outcome];
}

/** What the check of a new pair says: proved discharges the goal, anything else continues the run. */
export function formatEager(eager: CheckResult | undefined): string {
  if (!eager) return "";
  const said = `, the new pair is ${outcomeWord(eager.outcome)}`;
  const budgetMs = eager.invocation.timeoutMs;
  // A check that never asked alive2 says why, which tells more than its timing.
  const unasked = eager.outcome === "correct" && !eager.summary && eager.detail;
  if (eager.outcome === "error" || unasked) return `${said}: ${eager.detail}`;
  if (eager.outcome === "unknown") return `${said} in ${budgetMs}ms, so the goal stays open`;
  const timed = `${said} in ${eager.ms}ms (${budgetMs}ms budget)`;
  return eager.outcome === "incorrect"
    ? `${timed}; the goal stays open, and the example is only a hint`
    : timed;
}

/** The example a refuted check of the new pair found; anything else it said is noise. */
export function formatEagerDetail(eager: CheckResult | undefined): string {
  return eager?.outcome === "incorrect" ? formatDetail(eager) : "";
}

/** One part of an answer under its title, so a reader can tell the parts apart. */
export function formatSection(title: string, body: string): string {
  return `## ${title}\n${body}`;
}

/**
 * What a check printed. alive2's own output, which comes with its summary,
 * goes under its title in a fence; our words about a check that never ran
 * stay as they are.
 */
export function formatDetail(check: CheckResult | undefined): string {
  const detail = check?.detail.trim() ?? "";
  if (!detail || !check?.summary) return detail;
  return formatSection("alive2", `\`\`\`text\n${detail}\n\`\`\``);
}

/** A cut's parameters, and why no fact holds yet for one the src passes poison for. */
export function formatParams(params: OutlineParam[], hypothesis?: string): string {
  const lines = params.map(
    (param, at) => `  ${at}: ${param.param} ${param.type}, the src's ${param.live}`,
  );
  const ghosts = params.flatMap((param, at) => (param.live === "poison" ? [at] : []));
  if (ghosts.length === 0) return formatSection("Parameters", lines.join("\n"));
  const calls = hypothesis ? `at the outer's call and at @${hypothesis}` : "at the outer's call";
  const one = ghosts.length === 1;
  const ghostly = `The src has no value for parameter${one ? "" : "s"} ${ghosts.join(", ")}, so it passes poison. A fact about ${one ? "it" : "them"} holds only once the src passes a real value ${calls}.`;
  return formatSection("Parameters", `${lines.join("\n")}\n\n${ghostly}`);
}

/** Where a step left its side, as "g1 src is p3". */
export function formatMoved(session: Session, effects: Effect[]): string {
  const step = effects.find((effect) => effect.effect === "step");
  return step?.effect === "step" ? `${step.gid} ${step.side} is ${nameFor(session, step.to)}` : "";
}

/** How many edits a transaction holds, in words. */
export function formatEdits(count: number): string {
  return `${count} edit${count === 1 ? "" : "s"}`;
}

/** The name a program goes by, which is what a caller says back to us. */
export function nameFor(session: Session, hash: Hash): string {
  return session.tree.programs.get(hash) ?? hash.slice(0, 12);
}

/** A program as the model reads it: what to call it, then what it says. */
export function formatProgram(title: string, text: string): string {
  return formatSection(title, `\`\`\`llvm\n${text.trimEnd()}\n\`\`\``);
}

/** One goal on one line: what it is, where it stands, and its two programs. */
export function formatGoalLine(session: Session, goal: GoalStanding): string {
  const role = goal.role ? `${goal.role} of ${goal.parent}` : "root";
  const pair = `src ${nameFor(session, goal.src)}, tgt ${nameFor(session, goal.tgt)}`;
  return `${goal.gid} ${role}, ${goal.status}, ${pair}`;
}

/** The goals as a tree, each under the one it was cut from. */
export function formatGoalTree(session: Session, goals: GoalStanding[]): string {
  const under = (parent: string | undefined): GoalStanding[] =>
    goals.filter((goal) => goal.parent === parent);
  const lines: string[] = [];
  const walk = (goal: GoalStanding, depth: number): void => {
    lines.push(`${"  ".repeat(depth)}${formatGoalLine(session, goal)}`);
    for (const child of under(goal.gid)) walk(child, depth + 1);
  };
  for (const root of under(undefined)) walk(root, 0);
  return lines.join("\n");
}
