// Cuts a goal in two at a point both sides share, passing each value that
// crosses it as the tgt value the diff matched with it. A cut at the header of
// a loop leaves one iteration, whose back edge calls the hypothesis, so the
// goals it leaves prove by induction.
import type { Instruction, Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { diff } from "./regions.ts";
import { bodies } from "./windows.ts";

/** One cut of goal `gid`, or nothing when the framework refuses it or a value has no match. */
export async function cut(
  session: Session,
  llops: Llops,
  gid: string,
  srcCut: string,
  tgtCut: string,
) {
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

/** Cuts goal `gid` at its first loop header and the tgt's matching one, if its src loops. */
export async function cutLoop(session: Session, llops: Llops, gid: string) {
  const [src, tgt] = await bodies(session, llops, gid);
  const header = headers(src)[0];
  const partner = header ? diff(src, tgt).pairs.get(header) : undefined;
  if (!header || !partner) return undefined;
  return cut(session, llops, gid, header, partner);
}

/**
 * The blocks a branch goes back to, outermost first. Blocks are listed in
 * reverse postorder, so a branch to a block listed no later than its own is
 * a loop's back edge.
 */
function headers(body: Instruction[]): string[] {
  const order = [...new Set(body.map((i) => i.block))];
  const position = new Map(order.map((block, k) => [block, k]));
  const found = new Set<string>();
  for (const i of body)
    for (const to of i.operands)
      if ((position.get(to) ?? Infinity) <= (position.get(i.block) ?? -1)) found.add(to);
  return order.filter((block) => found.has(block));
}
