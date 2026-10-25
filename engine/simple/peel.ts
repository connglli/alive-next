// Cuts a goal so that a region its steps left stands alone: once after the
// region, then at its head, where a region that starts with a phi is cut at its
// block. A cut the framework refuses ends the peel.
import type { Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { type Assumed, cut, firstOwn } from "./cuts.ts";
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
  // A region that ends among its block's phis has no cut after it: phis stay together.
  const next = [src[b + 1], tgt[d + 1]];
  const within = next[0]?.block === src[b]?.block && next[1]?.block === tgt[d]?.block;
  if (within && !next.some((i) => i?.phi)) {
    const halves = await cut(session, llops, at, limits, `#${b + 1}`, `#${d + 1}`, assumed);
    if (!halves) return none;
    after.push(halves.callee);
    at = halves.outer;
  }
  const first = a <= firstOwn(src) && c <= firstOwn(tgt);
  if (first) return { goals: [at, ...after], region: at };
  const phi = src[a]?.phi || tgt[c]?.phi;
  const head = phi ? [src[a]?.block, tgt[c]?.block] : [`#${a}`, `#${c}`];
  const [srcHead = "", tgtHead = ""] = head;
  const halves = await cut(session, llops, at, limits, srcHead, tgtHead, assumed);
  if (!halves) return { goals: [at, ...after], region: at };
  return { goals: [halves.outer, halves.callee, ...after], region: halves.callee };
}
