// Cuts a goal so that a region its steps left stands alone: once after the
// region, then at its head, where a region that starts with a phi is cut at its
// block. A cut the framework refuses ends the peel.
import type { Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { type Assumed, cut } from "./cuts.ts";
import type { Limits } from "./limits.ts";
import type { Region } from "./regions.ts";
import { bodies } from "./windows.ts";

/** Peels `region` out of goal `gid`: the goals left in body order, and the one holding it. */
export async function peel(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  region: Region,
  assumed?: Assumed,
) {
  const [src, tgt] = await bodies(session, llops, gid);
  const [a, b, c, d] = [region.src[0], region.src.at(-1), region.tgt[0], region.tgt.at(-1)];
  const none = { goals: [gid], region: gid };
  if (a === undefined || b === undefined || c === undefined || d === undefined) return none;
  const after: string[] = [];
  let at = gid;
  if (src[b + 1]?.block === src[b]?.block && tgt[d + 1]?.block === tgt[d]?.block) {
    const split = await cut(session, llops, at, limits, `#${b + 1}`, `#${d + 1}`, assumed);
    if (!split) return none;
    after.push(split.callee);
    at = split.outer;
  }
  if (a === 0 && c === 0) return { goals: [at, ...after], region: at };
  const head = src[a]?.phi ? [src[a]?.block, tgt[c]?.block] : [`#${a}`, `#${c}`];
  const [srcHead = "", tgtHead = ""] = head;
  const split = await cut(session, llops, at, limits, srcHead, tgtHead, assumed);
  if (!split) return { goals: [at, ...after], region: at };
  return { goals: [split.outer, split.callee, ...after], region: split.callee };
}
