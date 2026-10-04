// Cuts a goal in two at a point both sides share, passing each value that
// crosses it as the tgt value the diff matched with it, and strengthens the cut
// with the facts the analyses know about those values, keeping the ones that
// hold. A cut at the header of a loop leaves one iteration, whose back edge
// calls the hypothesis, so the goals it leaves prove by induction, and it is
// strengthened with the invariants Houdini finds among those facts and some
// templates. A balanced cut splits a goal's expensive operations between its
// halves, so each half asks alive2 a smaller question.
import type { Instruction, Llops, OutlineParam } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { SplitResult } from "../core/state/splits.ts";
import { cutFacts, strengthenCut } from "./facts.ts";
import { fillCut } from "./fill.ts";
import { strengthenLoop } from "./invariants.ts";
import type { Limits } from "./limits.ts";
import { diff } from "./regions.ts";
import { relationsAt, type Side } from "./relations.ts";
import { bodies, partners } from "./windows.ts";

/**
 * The operations that make alive2's questions hard. Calls are not among them:
 * every cut adds one, so counting them would let cuts go on forever.
 */
const EXPENSIVE = new Set([
  "mul",
  "udiv",
  "sdiv",
  "urem",
  "srem",
  "fmul",
  "fdiv",
  "frem",
  "load",
  "store",
]);

/** How many candidate points a balanced cut tries before it gives up. */
const TRIES = 3;

/** One cut of goal `gid`, or nothing when the framework refuses it or a value has no match. */
export async function cut(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  srcCut: string,
  tgtCut: string,
) {
  const preview = await session.splitPreview(gid, srcCut, tgtCut);
  if (preview.kind !== "preview") return undefined;
  const [src, tgt] = await bodies(session, llops, gid);
  const map = valueMap(preview.params, preview.tgtParams ?? [], src, tgt);
  if (!map) return undefined;
  const split = await session.split(gid, srcCut, tgtCut, map);
  if (split.kind !== "split") return undefined;
  if (!(await fillCut(session, llops, split))) {
    await session.unsplit(gid);
    return undefined;
  }
  if (!limits.facts) return split.children;
  const view = await session.show(gid);
  const lives = split.params.map((param) => param.live);
  const tgtOnly = Object.entries(map).flatMap(([key, live]) =>
    key === `tgt${live}` ? [live] : [],
  );
  const images = lives.map((live) => (live === "poison" ? tgtOnly.shift() : map[live]));
  const [srcLoop, tgtLoop] = split.detach?.hypothesis ? [srcCut, tgtCut] : [];
  await strengthenSplit(session, llops, gid, split, [
    { module: view.src.text, point: pointOf(src, srcCut), values: lives, loop: srcLoop },
    { module: view.tgt.text, point: pointOf(tgt, tgtCut), values: images, loop: tgtLoop },
  ]);
  return split.children;
}

/**
 * The tgt partner of each value the src passes, and each tgt value the src
 * lacks under a key no src value has, or nothing when a src value has none.
 */
function valueMap(
  params: OutlineParam[],
  tgtParams: OutlineParam[],
  src: Instruction[],
  tgt: Instruction[],
) {
  const { pairs } = diff(src, tgt);
  const own = new Set(src.flatMap((i) => (i.value ? [i.value] : [])));
  const map: Record<string, string> = {};
  for (const { live } of params) {
    const partner = own.has(live) ? pairs.get(live) : live;
    if (!partner) return undefined;
    map[live] = partner;
  }
  const passed = new Set(Object.values(map));
  for (const { live } of tgtParams) if (!passed.has(live)) map[`tgt${live}`] = live;
  return map;
}

/** Strengthens `split` with the src's facts and the relations among what it passes. */
async function strengthenSplit(
  session: Session,
  llops: Llops,
  gid: string,
  split: Extract<SplitResult, { kind: "split" }>,
  [mine, theirs]: [Side, Side],
) {
  const lives = split.params.map((param) => param.live);
  const facts = await cutFacts(llops, mine.module, mine.point, lives);
  const types = split.params.map((param) => param.type);
  const relations = await relationsAt(llops, [mine, theirs], types);
  const candidates = { ...facts, predicates: [...(facts.predicates ?? []), ...relations] };
  const loop = split.detach?.hypothesis !== undefined;
  if (loop) await strengthenLoop(session, gid, candidates, split.params);
  else await strengthenCut(session, gid, candidates);
}

/**
 * Where the values a cut passes are analyzed: before the instruction it cuts
 * at, or before the first instruction of the block it cuts at that is not a
 * phi, where the facts hold however the block is entered.
 */
function pointOf(src: Instruction[], at: string): string {
  return at.startsWith("#") ? at : `#${src.findIndex((i) => i.block === at && !i.phi)}`;
}

/** Cuts goal `gid` at its first loop header, or a block that must be cut before it. */
export async function cutLoop(session: Session, llops: Llops, gid: string, limits: Limits) {
  const [src, tgt] = await bodies(session, llops, gid);
  const header = headers(src)[0];
  const at = header ? entryFirst(src, header) : undefined;
  const partner = at ? diff(src, tgt).pairs.get(at) : undefined;
  if (!at || !partner) return undefined;
  return cut(session, llops, gid, limits, at, partner);
}

/**
 * Cuts goal `gid` where both sides agree and its expensive operations split
 * most evenly, leaving at least one in each half.
 */
export async function cutBalanced(session: Session, llops: Llops, gid: string, limits: Limits) {
  const [src, tgt] = await bodies(session, llops, gid);
  const { regions } = diff(src, tgt);
  const before = (k: number) => src.slice(0, k).filter((i) => EXPENSIVE.has(i.opcode)).length;
  const total = before(src.length);
  const points = [...partners(src, tgt, regions)]
    .filter(([i, j]) => i > 0 && j >= 0 && !src[i]?.phi && !tgt[j]?.phi)
    .map(([i, j]) => ({ i, j, gap: Math.abs(total - 2 * before(i)), split: before(i) }))
    .filter((point) => point.split > 0 && point.split < total)
    .sort((a, b) => a.gap - b.gap);
  for (const point of points.slice(0, TRIES)) {
    const halves = await cut(session, llops, gid, limits, `#${point.i}`, `#${point.j}`);
    if (halves) return halves;
  }
  return undefined;
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

/** Where to cut to detach `block`: itself, or first where outside code enters its reach. */
function entryFirst(body: Instruction[], block: string, seen = new Set<string>()): string {
  const next = successors(body);
  const reached = new Set([block]);
  for (const from of reached) for (const to of next.get(from) ?? []) reached.add(to);
  const outside = [...next].flatMap(([from, tos]) => (reached.has(from) ? [] : tos));
  const entry = outside.find((to) => to !== block && reached.has(to));
  if (!entry || seen.has(entry)) return block;
  return entryFirst(body, entry, seen.add(block));
}

/** Each block's successors: the blocks its instructions name. */
function successors(body: Instruction[]): Map<string, string[]> {
  const next = new Map(body.map((i) => [i.block, [] as string[]]));
  for (const i of body) next.get(i.block)?.push(...i.operands.filter((to) => next.has(to)));
  return next;
}
