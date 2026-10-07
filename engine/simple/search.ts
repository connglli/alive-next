// The simple searcher, as one loop over an agenda of goals. A goal's moves are
// made in a fixed order (the optimizer's stages on the root, a stage of a looping
// program that its windows leave interposed as a goal of its own, windows and
// rules toward the tgt, a check, then a cut at a loop, before an expensive
// operation, around a region left, or where the expensive operations split
// evenly) until one proves it or splits it, and the goals a split leaves are
// searched before the next. Every move is a session move, so whatever it
// proves, the kernel replays.
import type { Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { type Assumed, balancedPoints, beforePoints, cut, cutLoop, quota } from "./cuts.ts";
import { strengthenAgainst } from "./facts.ts";
import type { Limits } from "./limits.ts";
import { peel } from "./peel.ts";
import { refuteFrom, unrolling } from "./refute.ts";
import { regions } from "./regions.ts";
import { stagesToward, stepRules } from "./rewrite.ts";
import { bodies, bodyOf, stepWindows } from "./windows.ts";

/** What a search works with, and how many cuts it may still make. */
interface Run {
  session: Session;
  llops: Llops;
  limits: Limits;
  cuts: number;
  /** The budget of a check before a cut. */
  eagerMs: number;
  /** The budget of a goal's last check, after its cuts: the largest a check may have. */
  capMs: number;
  /** The predicates each goal assumes at its entry. */
  assumed: Assumed;
}

/** A goal on the agenda: the moves it has left, and how to undo what split it. */
interface Goal {
  gid: string;
  moves: AsyncGenerator<Move>;
  undo?: "unsplit" | "uninterpose";
  /** The goal whose split left this one. */
  parent?: Goal;
}

/** One move on a goal, made when the search picks it. */
type Move = () => Promise<Answer>;

/** What a move came to: a proof, a refutation, the goals a split left, or none. */
type Answer =
  | { kind: "proved" }
  | { kind: "refuted"; detail: string }
  | { kind: "cut"; goals: Goal[] }
  | { kind: "interposed"; goals: Goal[] }
  | { kind: "none" };

const PROVED: Answer = { kind: "proved" };
const NONE: Answer = { kind: "none" };

/** Searches for a proof of the root goal, giving up with the goals left open if it finds none. */
export async function search(session: Session, llops: Llops, limits: Limits) {
  const { root, budgets } = await session.status();
  if ((await session.check(root, limits.rootMs)).outcome !== "unknown") return session.verdict;
  const [eagerMs, capMs] = [budgets.eagerCheckMs, budgets.checkCapMs];
  // A larger function gets more cuts than `limits.cuts`, unless cuts are off.
  const needed = quota(...(await bodies(session, llops, root)));
  const run: Run = {
    session,
    llops,
    limits,
    cuts: limits.cuts && Math.max(limits.cuts, needed),
    eagerMs,
    capMs,
    assumed: new Map(),
  };
  await unrolling(session, llops, root, limits.counterexampleMs);
  const { src, tgt } = await session.show(root);
  const walking = limits.stages && limits.steps;
  const stages = walking ? await stagesToward(llops, src.text, tgt.text) : [];
  const agenda = [goal(run, root, { stages })];
  // A check of the root's original pair may decide the run on the way.
  while (agenda.length > 0 && session.verdict === "unknown") {
    const top = agenda[agenda.length - 1] as Goal;
    // A goal a split landed on comes back once the goals it left, above it, are done.
    if (top.undo) await settle(run, agenda, top);
    else {
      const next = await top.moves.next();
      if (next.done) agenda.pop();
      else await learn(run, agenda, await next.value());
    }
  }
  if (session.verdict === "unknown") {
    const open = (await session.status()).goals.filter((g) => g.status === "open");
    await session.giveUp(`no move closed ${open.map((g) => g.gid).join(", ")}`);
  }
  return session.verdict;
}

/** Acts on the top goal's answer: a proof closes it, a refutation repairs, goals stack. */
async function learn(run: Run, agenda: Goal[], answer: Answer) {
  const top = agenda[agenda.length - 1] as Goal;
  if (answer.kind === "proved") agenda.pop();
  if (answer.kind === "refuted") await repair(run, agenda, top, answer.detail);
  if (answer.kind !== "cut" && answer.kind !== "interposed") return;
  top.undo = answer.kind === "cut" ? "unsplit" : "uninterpose";
  // An interpose rewrites rather than decomposes, and the stages bound how many there are.
  if (answer.kind === "cut") run.cuts -= 1;
  for (const left of answer.goals) left.parent = top;
  agenda.push(...[...answer.goals].reverse());
}

/** Refutes the run with `g`'s counterexample, else strengthens or undoes its cut. */
async function repair(run: Run, agenda: Goal[], g: Goal, detail: string) {
  if (await refuteFrom(run.session, g.gid, detail)) return;
  let cex = detail;
  for (;;) {
    const landed = await strengthenAgainst(run.session, g.gid, cex);
    if (landed.length === 0) break;
    run.assumed.set(g.gid, [...(run.assumed.get(g.gid) ?? []), ...landed]);
    await requeue(run, agenda, g);
    const { outcome, check } = await run.session.check(g.gid, run.eagerMs);
    if (outcome === "proved") agenda.pop();
    if (outcome !== "refuted" || !check) return;
    cex = check.detail;
  }
  await undo(run, agenda, g);
}

/** Puts the outer of `g`'s cut back below it, when strengthening the cut reopened it. */
async function requeue(run: Run, agenda: Goal[], g: Goal) {
  const { session } = run;
  const { parent } = await session.show(g.gid);
  for (const gid of parent ? (await session.show(parent)).children : []) {
    const reopened = (await session.show(gid)).status === "open";
    if (gid === g.gid || !reopened || agenda.some((queued) => queued.gid === gid)) continue;
    agenda.splice(agenda.length - 1, 0, { ...goal(run, gid), parent: g.parent });
  }
}

/** Pops goal `g` if proved, and else undoes its split so that it tries its next move. */
async function settle(run: Run, agenda: Goal[], g: Goal) {
  const proved = (await run.session.show(g.gid)).status === "proved";
  if (proved || !(await undone(run, g))) agenda.pop();
  else g.undo = undefined;
}

/** Undoes the split that left `g`, which proves no refuted goal; a root stays open. */
async function undo(run: Run, agenda: Goal[], g: Goal) {
  const parent = g.parent;
  if (!parent || !(await undone(run, parent))) {
    agenda.pop();
    return;
  }
  agenda.length = agenda.indexOf(parent) + 1;
  parent.undo = undefined;
}

/** Whether the cut or the interpose that split `g` was undone. */
async function undone(run: Run, g: Goal): Promise<boolean> {
  if (g.undo === "uninterpose")
    return (await run.session.uninterpose(g.gid)).kind === "uninterposed";
  return (await run.session.unsplit(g.gid)).kind === "unsplit";
}

/** What a goal starts its moves with: the stages left to walk, and what it skips. */
interface Start {
  stages?: string[];
  /** False for a peeled region, which is not peeled again. */
  peelable?: boolean;
  /** False for a step goal, whose windows the walk has just asked. */
  steps?: boolean;
}

/** Goal `gid` with its moves: stages for the root and what follows a stage interposed. */
function goal(run: Run, gid: string, start: Start = {}): Goal {
  return { gid, moves: moves(run, gid, start) };
}

/** The moves of goal `gid`, in the order they are made. */
async function* moves(
  run: Run,
  gid: string,
  { stages = [], peelable = true, steps = true }: Start,
) {
  const { session, llops, limits } = run;
  yield* walk(run, gid, stages);
  // Stages that end at the tgt's body have asked the goal's windows toward it already.
  const last = stages.at(-1);
  const view = await session.show(gid);
  const walked = last !== undefined && bodyOf(last) === bodyOf(view.tgt.text);
  // Strengthening a cut checks its goals again, which may have proved this one.
  yield async () => ((await session.show(gid)).status === "proved" ? PROVED : NONE);
  const toward = () => stepWindows(session, llops, gid, limits);
  if (limits.steps && steps && !walked) yield stepping(toward);
  if (limits.steps && steps && limits.rules) yield stepping(() => stepByRules(run, gid));
  // A goal gets a short check before it is cut, and the largest one when nothing cuts it.
  yield checking(run, gid, run.eagerMs);
  const [src, tgt] = await bodies(session, llops, gid);
  const at = (point: [string, string]) =>
    halves(run, () => cut(session, llops, gid, limits, ...point, run.assumed));
  yield halves(run, () => cutLoop(session, llops, gid, limits, run.assumed));
  for (const point of beforePoints(src, tgt)) yield at(point);
  if (peelable) yield peeled(run, gid);
  for (const point of balancedPoints(src, tgt)) yield at(point);
  yield checking(run, gid, run.capMs);
}

/** A move that checks a goal on budget `ms`. */
function checking(run: Run, gid: string, ms: number): Move {
  return async () => {
    const { outcome, check } = await run.session.check(gid, ms);
    if (outcome === "refuted" && check) return { kind: "refuted", detail: check.detail };
    return outcome === "proved" ? PROVED : NONE;
  };
}

/** A move that steps a goal, which leaves it to the moves after. */
function stepping(step: () => Promise<unknown>): Move {
  return async () => {
    await step();
    return NONE;
  };
}

/** A move that cuts a goal in two while cuts remain, answering with the halves. */
function halves(run: Run, cutting: () => ReturnType<typeof cutLoop>): Move {
  return async () => {
    const made = run.cuts > 0 && (await cutting());
    if (!made) return NONE;
    return { kind: "cut", goals: [goal(run, made.outer), goal(run, made.callee)] };
  };
}

/** A move that peels the first region left out of goal `gid`. */
function peeled(run: Run, gid: string): Move {
  return async () => {
    const { session, llops, limits } = run;
    if (run.cuts <= 0) return NONE;
    const [region] = regions(...(await bodies(session, llops, gid)));
    const made = region && (await peel(session, llops, gid, limits, region, run.assumed));
    if (!made || made.goals.length < 2) return NONE;
    const goals = made.goals.map((g) => goal(run, g, { peelable: g !== made.region }));
    return { kind: "cut", goals };
  };
}

/** Steps goal `gid` by the rules where regions are left, then by the windows they open. */
async function stepByRules(run: Run, gid: string) {
  const { session, llops, limits } = run;
  if (regions(...(await bodies(session, llops, gid))).length === 0) return;
  if (await stepRules(session, llops, gid)) await stepWindows(session, llops, gid, limits);
}

/**
 * The moves that step goal `gid`'s src through `stages`: each stage's windows,
 * then one step of the whole function to it, and on a program that loops, a
 * stage neither reaches interposed, so that the step to it is a goal of its own
 * and the rest walks on.
 */
async function* walk(run: Run, gid: string, stages: string[]) {
  const { session, llops, limits } = run;
  // A later stage holds this one's changes, so a jump alive2 cannot decide ends
  // the jumps, and a step goal left open ends the interposes.
  let [jumping, interposable] = [true, true];
  for (const [k, stage] of stages.entries()) {
    let left = 0;
    yield stepping(async () => {
      left = (await stepWindows(session, llops, gid, limits, stage)).length;
    });
    if (left === 0) continue;
    let outcome: string | undefined;
    if (jumping)
      yield stepping(async () => {
        outcome = await jump(session, gid, stage);
      });
    if (outcome === "correct") continue;
    if (outcome === "unknown") jumping = false;
    // alive2 refuses a step on a program that loops, which only the cuts of a step goal
    // can prove; a step goal on one that does not would repeat what the goal's cuts do.
    const provable = interposable && limits.interpose && run.cuts > 0;
    if (!provable || outcome !== "error") continue;
    yield interposing(run, gid, stage, stages.slice(k + 1));
    interposable = false;
  }
}

/** A move that interposes `stage` in goal `gid`: the step to it, and the rest from it. */
function interposing(run: Run, gid: string, stage: string, rest: string[]): Move {
  return async () => {
    const { session, llops } = run;
    const { src } = await session.show(gid);
    const middle = await llops.edit(src.text, { op: "set_body", body: bodyOf(stage) });
    if (!middle.ok) return NONE;
    const made = await session.interpose(gid, middle.module);
    if (made.kind !== "interposed") return NONE;
    const { lhs, rhs } = made.children;
    return {
      kind: "interposed",
      goals: [goal(run, lhs, { steps: false }), goal(run, rhs, { stages: rest })],
    };
  };
}

/** One step of the whole function to `stage`, for what its windows left; how it went. */
async function jump(session: Session, gid: string, stage: string) {
  await session.begin(gid, "src");
  const edited = await session.edit({ op: "set_body", body: bodyOf(stage) });
  if (edited.kind === "refused") {
    await session.abort();
    return undefined;
  }
  const step = await session.commit({ narrow: false, eager: false });
  return step.kind === "certified" ? "correct" : step.check.outcome;
}
