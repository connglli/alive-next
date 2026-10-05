// The simple searcher. It rewrites the root's src into its tgt region by region,
// first through the stages the optimizer makes of the src, and closes each goal
// by a check. A goal that does not close is cut at a loop header, before an
// expensive operation, around a region its steps left, or where its expensive
// operations split evenly. Every move is a session move, so whatever it
// proves, the kernel replays.
import type { Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { cutBalanced, cutBefore, cutLoop } from "./cuts.ts";
import type { Limits } from "./limits.ts";
import { peel } from "./peel.ts";
import { regions } from "./regions.ts";
import { stagesToward, stepRules } from "./rewrite.ts";
import { bodies, bodyOf, stepWindows } from "./windows.ts";

/** What a search may still spend. */
interface Budget {
  cuts: number;
}

/** Searches for a proof of the root goal, giving up with the goals left open if it finds none. */
export async function search(session: Session, llops: Llops, limits: Limits) {
  const budget = { cuts: limits.cuts };
  const { root } = await session.status();
  if ((await session.check(root, limits.rootMs)).outcome !== "unknown") return session.verdict;
  if (limits.stages && limits.steps) await followStages(session, llops, root, limits);
  const open = await solve(session, llops, root, limits, budget, true);
  if (open.length > 0) await session.giveUp(`no move closed ${open.join(", ")}`);
  return session.verdict;
}

/** Steps the root's src through the stages the optimizer makes of it, toward its tgt. */
async function followStages(session: Session, llops: Llops, root: string, limits: Limits) {
  const { src, tgt } = await session.show(root);
  // A later stage holds this one's changes, so a jump alive2 cannot decide ends the jumps.
  let jumping = true;
  for (const stage of await stagesToward(llops, src.text, tgt.text)) {
    const left = await stepWindows(session, llops, root, limits, stage);
    if (!jumping || left.length === 0) continue;
    jumping = (await jump(session, root, stage)) !== "unknown";
  }
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

/**
 * Closes a goal by windows and a check, or else cuts it, at a loop header,
 * before an expensive operation, around a region, or where its expensive
 * operations split evenly, and solves what the cut leaves. Returns the goals
 * left open.
 */
async function solve(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  budget: Budget,
  peelable: boolean,
): Promise<string[]> {
  // Strengthening a cut checks its goals again, which may have proved this one.
  if ((await session.show(gid)).status === "proved") return [];
  let left = limits.steps
    ? await stepWindows(session, llops, gid, limits)
    : regions(...(await bodies(session, llops, gid)));
  const rules = limits.steps && limits.rules && left.length > 0;
  if (rules && (await stepRules(session, llops, gid)))
    left = await stepWindows(session, llops, gid, limits);
  if ((await session.check(gid)).outcome === "proved") return [];
  if (budget.cuts <= 0) return [gid];
  // Solves the goals a cut left, except that the one holding a peeled region is not peeled again.
  const spend = async (goals: string[], held?: string) => {
    budget.cuts -= 1;
    const open: string[] = [];
    for (const goal of goals)
      open.push(...(await solve(session, llops, goal, limits, budget, goal !== held)));
    return open;
  };
  const loop = await cutLoop(session, llops, gid, limits);
  if (loop) return spend([loop.outer, loop.callee]);
  const before = await cutBefore(session, llops, gid, limits);
  if (before) return spend([before.outer, before.callee]);
  const region = left[0];
  const peeled = region && peelable ? await peel(session, llops, gid, limits, region) : undefined;
  if (peeled && peeled.goals.length > 1) return spend(peeled.goals, peeled.region);
  const halves = await cutBalanced(session, llops, gid, limits);
  return halves ? spend([halves.outer, halves.callee]) : [gid];
}
