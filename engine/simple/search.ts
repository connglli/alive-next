// The simple searcher. It rewrites the root's src into its tgt region by region,
// first through the stages the optimizer makes of the src, then cuts loops at
// their headers, peels what no window holds into goals of their own, and closes
// each goal by a check. Every move is a session move, so whatever it proves,
// the kernel replays.
import type { Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { cutLoop } from "./cuts.ts";
import type { Limits } from "./limits.ts";
import { peel } from "./peel.ts";
import { regions } from "./regions.ts";
import { bodies, bodyOf, stepWindows } from "./windows.ts";

/** What a search may still spend. */
interface Budget {
  cuts: number;
  until: number;
}

/** Searches for a proof of the root goal, giving up with the goals left open if it finds none. */
export async function search(session: Session, llops: Llops, limits: Limits) {
  const budget = { cuts: limits.cuts, until: Date.now() + limits.ms };
  const { root } = await session.status();
  if ((await session.check(root, limits.rootMs)).outcome !== "unknown") return session.verdict;
  if (limits.stages && limits.steps) await followStages(session, llops, root, limits, budget);
  const open = await solve(session, llops, root, limits, budget, true);
  if (open.length > 0) await session.giveUp(`no move closed ${open.join(", ")}`);
  return session.verdict;
}

/** Steps the root's src through each stage the optimizer makes of it. */
async function followStages(
  session: Session,
  llops: Llops,
  root: string,
  limits: Limits,
  budget: Budget,
) {
  const run = await llops.pipelineStages((await session.show(root)).src.text);
  for (const stage of run.ok ? run.stages : []) {
    if (Date.now() > budget.until) return;
    const canon = await llops.canon(stage.module);
    if (!canon.ok) continue;
    const left = await stepWindows(session, llops, root, limits, canon.module);
    if (left.length > 0) await jump(session, root, canon.module);
  }
}

/** One step of the whole function to `stage`, for what its windows left. */
async function jump(session: Session, gid: string, stage: string) {
  await session.begin(gid, "src");
  const edited = await session.edit({ op: "set_body", body: bodyOf(stage) });
  if (edited.kind === "refused") return session.abort();
  return session.commit({ narrow: false, eager: false });
}

/**
 * Closes a goal by windows, a check and peeling, and returns the goals left
 * open. A goal a peel left holding its region alone is not peeled again.
 */
async function solve(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  budget: Budget,
  peelable: boolean,
): Promise<string[]> {
  if (Date.now() > budget.until) return [gid];
  const left = limits.steps
    ? await stepWindows(session, llops, gid, limits)
    : regions(...(await bodies(session, llops, gid)));
  if ((await session.check(gid)).outcome === "proved") return [];
  const loop = budget.cuts > 0 ? await cutLoop(session, llops, gid) : undefined;
  if (loop) {
    budget.cuts -= 1;
    const outer = await solve(session, llops, loop.outer, limits, budget, true);
    return [...outer, ...(await solve(session, llops, loop.callee, limits, budget, true))];
  }
  const region = left[0];
  if (!region || !peelable || budget.cuts <= 0) return [gid];
  const peeled = await peel(session, llops, gid, region);
  if (peeled.goals.length < 2) return [gid];
  budget.cuts -= 1;
  const open: string[] = [];
  for (const goal of peeled.goals)
    open.push(...(await solve(session, llops, goal, limits, budget, goal !== peeled.region)));
  return open;
}
