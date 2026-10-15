// The simple searcher, as one loop over an agenda of goals. A goal's moves are
// made in a fixed order (the optimizer's stages on the root, a stage of a looping
// program that its windows leave interposed as a goal of its own, windows and
// rules toward the tgt, a check, then a cut at a loop, before an expensive
// operation, around a region left, or where the expensive operations split
// evenly) until one proves it or splits it, and the goals a split leaves are
// searched before the next. Every move is a session move, so whatever it
// proves, the kernel replays.
import type { Instruction, Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import {
  balancedPoints,
  beforePoints,
  cut,
  cutLoop,
  type Learned,
  learning,
  quota,
} from "./cuts.ts";
import { strengthenAgainst } from "./facts.ts";
import type { Limits } from "./limits.ts";
import { peel } from "./peel.ts";
import { refuteFrom, unrolling } from "./refute.ts";
import { regions } from "./regions.ts";
import { stagesToward, stepRules } from "./rewrite.ts";
import { bodies, bodyOf, stepWindows } from "./windows.ts";

/** What a search works with. */
interface Run {
  session: Session;
  llops: Llops;
  limits: Limits;
  /** The budget of a check before a cut. */
  eagerMs: number;
  /** The budget of a goal's last check, after its cuts: the largest a check may have. */
  capMs: number;
  /** What the run learns at its cuts. */
  learned: Learned;
}

/** How many cuts a goal, and the goals its cuts leave, may still make. */
interface Cuts {
  left: number;
}

/** A goal on the agenda: the moves it has left, and how to undo what split it. */
interface Goal {
  gid: string;
  moves: AsyncGenerator<Move>;
  cuts: Cuts;
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
  const run: Run = { session, llops, limits, eagerMs, capMs, learned: learning() };
  await unrolling(session, llops, root, limits.counterexampleMs);
  await dropAttrs(session, llops, root);
  const { src, tgt } = await session.show(root);
  const walking = limits.stages && limits.steps;
  const stages = walking ? await stagesToward(llops, src.text, tgt.text) : [];
  const cuts = quotaOf(limits, await bodies(session, llops, root));
  const agenda = [goal(run, root, { stages, cuts })];
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

/** Drops from the tgt the attributes `llops respected` shows its instructions keep. */
async function dropAttrs(session: Session, llops: Llops, gid: string) {
  const held = await llops.validate((await session.show(gid)).tgt.text);
  if (!held.ok || held.body_attrs.length === 0) return;
  await session.begin(gid, "tgt");
  if ((await session.edit({ op: "drop_attrs" })).kind !== "applied") {
    await session.abort();
    return;
  }
  await session.commit({ eager: false });
}

/** Acts on the top goal's answer: a proof closes it, a refutation repairs, goals stack. */
async function learn(run: Run, agenda: Goal[], answer: Answer) {
  const top = agenda[agenda.length - 1] as Goal;
  if (answer.kind === "proved") agenda.pop();
  if (answer.kind === "refuted") await repair(run, agenda, top, answer.detail);
  if (answer.kind !== "cut" && answer.kind !== "interposed") return;
  top.undo = answer.kind === "cut" ? "unsplit" : "uninterpose";
  // An interpose rewrites rather than decomposes, and the stages bound how many there are.
  if (answer.kind === "cut") top.cuts.left -= 1;
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
    const { assumed } = run.learned;
    assumed.set(g.gid, [...(assumed.get(g.gid) ?? []), ...landed]);
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
    const back = { ...goal(run, gid, { cuts: g.cuts }), parent: g.parent };
    agenda.splice(agenda.length - 1, 0, back);
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

/** What a goal starts with: its cuts, the stages left to walk, and what it skips. */
interface Start {
  cuts: Cuts;
  stages?: string[];
  /** False for a peeled region, which is not peeled again. */
  peelable?: boolean;
  /** False for a step goal, whose windows the walk has just asked. */
  steps?: boolean;
}

/** Goal `gid` with its moves: stages for the root and what follows a stage interposed. */
function goal(run: Run, gid: string, start: Start): Goal {
  return { gid, cuts: start.cuts, moves: moves(run, gid, start) };
}

/** A goal's cuts: one per expensive operation and loop, and `limits.cuts` at least. */
function quotaOf(limits: Limits, [src, tgt]: [Instruction[], Instruction[]]): Cuts {
  return { left: limits.cuts && Math.max(limits.cuts, quota(src, tgt)) };
}

/** The moves of goal `gid`, in the order they are made. */
async function* moves(
  run: Run,
  gid: string,
  { cuts, stages = [], peelable = true, steps = true }: Start,
) {
  const { session, llops, limits } = run;
  yield* walk(run, gid, stages, cuts);
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
    halves(run, cuts, () => cut(session, llops, gid, limits, ...point, run.learned));
  yield halves(run, cuts, () => cutLoop(session, llops, gid, limits, run.learned));
  for (const point of beforePoints(src, tgt)) yield at(point);
  if (peelable) yield peeled(run, gid, cuts);
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

/** A move that cuts a goal in two while its cuts remain, answering with the halves. */
function halves(run: Run, cuts: Cuts, cutting: () => ReturnType<typeof cutLoop>): Move {
  return async () => {
    const made = cuts.left > 0 && (await cutting());
    if (!made) return NONE;
    return {
      kind: "cut",
      goals: [goal(run, made.outer, { cuts }), goal(run, made.callee, { cuts })],
    };
  };
}

/** A move that peels the first region left out of goal `gid`. */
function peeled(run: Run, gid: string, cuts: Cuts): Move {
  return async () => {
    const { session, llops, limits } = run;
    if (cuts.left <= 0) return NONE;
    const [region] = regions(...(await bodies(session, llops, gid)));
    const made = region && (await peel(session, llops, gid, limits, region, run.learned));
    if (!made || made.goals.length < 2) return NONE;
    const peelable = (id: string) => id !== made.region;
    const goals = made.goals.map((id) => goal(run, id, { cuts, peelable: peelable(id) }));
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
async function* walk(run: Run, gid: string, stages: string[], cuts: Cuts) {
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
    const provable = interposable && limits.interpose && limits.cuts > 0;
    if (!provable || outcome !== "error") continue;
    yield interposing(run, gid, stages.slice(k), cuts);
    interposable = false;
  }
}

/**
 * A move that interposes the first of `stages` in goal `gid`: the step to it,
 * and the rest from it, which walks the other stages.
 */
function interposing(run: Run, gid: string, stages: string[], cuts: Cuts): Move {
  return async () => {
    const { session, llops } = run;
    const [stage = "", ...rest] = stages;
    const { src } = await session.show(gid);
    const middle = await llops.edit(src.text, { op: "set_body", body: bodyOf(stage) });
    if (!middle.ok) return NONE;
    const made = await session.interpose(gid, middle.module);
    if (made.kind !== "interposed") return NONE;
    const { lhs, rhs } = made.children;
    // The step gets cuts of its own, so that a chain of steps spends none of the rest's.
    const own = quotaOf(run.limits, await bodies(session, llops, lhs));
    const step = goal(run, lhs, { cuts: own, steps: false });
    return { kind: "interposed", goals: [step, goal(run, rhs, { stages: rest, cuts })] };
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
