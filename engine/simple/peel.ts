// Cuts a goal so that a region a window cannot hold stands alone: once after
// the region, then at its head, where a region that starts with a phi is cut
// at its block. Each cut passes every value as the tgt value the diff matched
// with it. A cut the framework refuses ends the peel.
import type { Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { diff, type Region } from "./regions.ts";
import { bodies } from "./windows.ts";

/** Peels `region` out of goal `gid`: the goals left in body order, and the one holding it. */
export async function peel(session: Session, llops: Llops, gid: string, region: Region) {
  const [src, tgt] = await bodies(session, llops, gid);
  const [a, b, c, d] = [region.src[0], region.src.at(-1), region.tgt[0], region.tgt.at(-1)];
  const none = { goals: [gid], region: gid };
  if (a === undefined || b === undefined || c === undefined || d === undefined) return none;
  const after: string[] = [];
  let at = gid;
  if (src[b + 1]?.block === src[b]?.block && tgt[d + 1]?.block === tgt[d]?.block) {
    const split = await cut(session, llops, at, `#${b + 1}`, `#${d + 1}`);
    if (!split) return none;
    after.push(split.callee);
    at = split.outer;
  }
  if (a === 0 && c === 0) return { goals: [at, ...after], region: at };
  const head = src[a]?.phi ? [src[a]?.block, tgt[c]?.block] : [`#${a}`, `#${c}`];
  const split = await cut(session, llops, at, head[0] ?? "", head[1] ?? "");
  if (!split) return { goals: [at, ...after], region: at };
  return { goals: [split.outer, split.callee, ...after], region: split.callee };
}

/** One cut, passing each value that crosses it as the tgt value the diff matched with it. */
async function cut(session: Session, llops: Llops, gid: string, srcCut: string, tgtCut: string) {
  const preview = await session.splitPreview(gid, srcCut, tgtCut);
  if (preview.kind !== "preview") return undefined;
  const [src, tgt] = await bodies(session, llops, gid);
  const { pairs } = diff(src, tgt);
  const own = new Set(src.flatMap((i) => (i.value ? [i.value] : [])));
  const map: Record<string, string> = {};
  for (const { live } of preview.params) {
    const partner = own.has(live) ? pairs.get(live) : live;
    if (!partner) return undefined;
    map[live] = partner;
  }
  const split = await session.split(gid, srcCut, tgtCut, map);
  return split.kind === "split" ? split.children : undefined;
}
