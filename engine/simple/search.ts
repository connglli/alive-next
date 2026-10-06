// The simple searcher, as one loop over an agenda of goals. A goal's moves are
// made in a fixed order (the optimizer's stages on the root, windows and rules
// toward the tgt, a check, then a cut at a loop, before an expensive operation,
// around a region left, or where the expensive operations split evenly) until
// one proves it or cuts it, and the goals a cut leaves are searched before the
// next. Every move is a session move, so whatever it proves, the kernel replays.
import type { Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { type Assumed, balancedPoints, beforePoints, cut, cutLoop } from "./cuts.ts";
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

/** A goal on the agenda: the moves it has left, and whether a cut landed on it. */
interface Goal {
  gid: string;
  moves: AsyncGenerator<Move>;
  cut?: boolean;
  /** The goal whose cut left this one. */
  parent?: Goal;
}

/** One move on a goal, made when the search picks it. */
type Move = () => Promise<Answer>;

/** What a move came to: a proof, a refutation, a cut into goals to search, or none. */
type Answer =
  | { kind: "proved" }
  | { kind: "refuted"; detail: string }
  | { kind: "cut"; goals: Goal[] }
  | { kind: "none" };

const PROVED: Answer = { kind: "proved" };
const NONE: Answer = { kind: "none" };

/** Searches for a proof of the root goal, giving up with the goals left open if it finds none. */
export async function search(session: Session, llops: Llops, limits: Limits) {
  const { root, budgets } = await session.status();
  if ((await session.check(root, limits.rootMs)).outcome !== "unknown") return session.verdict;
  const [eagerMs, capMs] = [budgets.eagerCheckMs, budgets.checkCapMs];
  const run: Run = {
    session,
    llops,
    limits,
    cuts: limits.cuts,
    eagerMs,
    capMs,
    assumed: new Map(),
  };
  await unrolling(session, llops, root, limits.counterexampleMs);
  const agenda = [goal(run, root, { stages: true })];
  // A check of the root's original pair may decide the run on the way.
  while (agenda.length > 0 && session.verdict === "unknown") {
    const top = agenda[agenda.length - 1] as Goal;
    // A goal a cut landed on comes back once the goals it left, above it, are done.
    if (top.cut) await settle(run, agenda, top);
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

/** Acts on the top goal's answer: a proof closes it, a refutation repairs, a cut stacks. */
async function learn(run: Run, agenda: Goal[], answer: Answer) {
  const top = agenda[agenda.length - 1] as Goal;
  if (answer.kind === "proved") agenda.pop();
  if (answer.kind === "refuted") await repair(run, agenda, top, answer.detail);
  if (answer.kind !== "cut") return;
  top.cut = true;
  run.cuts -= 1;
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
    if (outcome !== "refuted") return;
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

/** Pops cut goal `g` if proved, and else undoes its cut so that it tries its next move. */
async function settle(run: Run, agenda: Goal[], g: Goal) {
  const proved = (await run.session.show(g.gid)).status === "proved";
  if (proved || (await run.session.unsplit(g.gid)).kind !== "unsplit") agenda.pop();
  else g.cut = false;
}

/** Undoes the cut that left `g`, since no cut proves a refuted goal; a root stays open. */
async function undo(run: Run, agenda: Goal[], g: Goal) {
  const parent = g.parent;
  if (!parent || (await run.session.unsplit(parent.gid)).kind !== "unsplit") {
    agenda.pop();
    return;
  }
  agenda.length = agenda.indexOf(parent) + 1;
  parent.cut = false;
}

/** Goal `gid` with its moves: stages for the root only, and no peel of a peeled region. */
function goal(run: Run, gid: string, { stages = false, peelable = true } = {}): Goal {
  return { gid, moves: moves(run, gid, stages, peelable) };
}

/** The moves of goal `gid`, in the order they are made. */
async function* moves(run: Run, gid: string, stages: boolean, peelable: boolean) {
  const { session, llops, limits } = run;
  // Stages that end at the tgt's body have asked the root's windows toward it already.
  let walked = false;
  if (stages && limits.stages && limits.steps)
    yield stepping(async () => {
      walked = await followStages(session, llops, gid, limits);
    });
  // Strengthening a cut checks its goals again, which may have proved this one.
  yield async () => ((await session.show(gid)).status === "proved" ? PROVED : NONE);
  const walk = () => stepWindows(session, llops, gid, limits);
  if (limits.steps && !walked) yield stepping(walk);
  if (limits.steps && limits.rules) yield stepping(() => stepByRules(run, gid));
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
    if (outcome === "refuted") return { kind: "refuted", detail: check.detail };
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

/** Steps the root's src through the stages; whether the last one has its tgt's body. */
async function followStages(session: Session, llops: Llops, root: string, limits: Limits) {
  const { src, tgt } = await session.show(root);
  const stages = await stagesToward(llops, src.text, tgt.text);
  // A later stage holds this one's changes, so a jump alive2 cannot decide ends the jumps.
  let jumping = true;
  for (const stage of stages) {
    const left = await stepWindows(session, llops, root, limits, stage);
    if (!jumping || left.length === 0) continue;
    jumping = (await jump(session, root, stage)) !== "unknown";
  }
  const last = stages.at(-1);
  return last !== undefined && bodyOf(last) === bodyOf(tgt.text);
}

/** One step of the whole function to `stage`, for what its windows left; alive2's answer. */
async function jump(session: Session, gid: string, stage: string) {
  await session.begin(gid, "src");
  const edited = await session.edit({ op: "set_body", body: bodyOf(stage) });
  if (edited.kind === "refused") {
    await session.abort();
    return undefined;
  }
  return (await session.commit({ narrow: false, eager: false })).check.outcome;
}
