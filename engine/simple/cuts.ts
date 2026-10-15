// Cuts a goal in two at a point both sides share, passing each value that
// crosses it as the tgt value the diff matched with it, and strengthens the cut
// with the facts the analyses know about those values, keeping the ones that
// hold. A cut at the header of a loop leaves one iteration, whose back edge
// calls the hypothesis, so the goals it leaves prove by induction, and it is
// strengthened with the invariants Houdini finds among those facts and some
// guesses. A cut before an expensive operation hands it the same operands on
// both sides, and a balanced cut splits a goal's expensive operations between
// its halves.
import type { Instruction, Llops, OutlineParam, Predicate } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { SplitResult } from "../core/state/splits.ts";
import type { StrengthenContract } from "../core/state/strengthen.ts";
import { cutFacts, passedOn, predicatesAt, strengthenCut, union } from "./facts.ts";
import { fillCut } from "./fill.ts";
import type { Limits } from "./limits.ts";
import { guessInvariants, loopCut, strengthenLoop, unfoldToMatch } from "./loops.ts";
import { diff, dominates, headers, successors } from "./regions.ts";
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
  "fadd",
  "fsub",
  "fmul",
  "fdiv",
  "frem",
  "load",
  "store",
]);

/** How many points a cut before an expensive operation or a balanced cut tries. */
const TRIES = 3;

/** Whether `i` is one of those operations, a multiplication only when both factors vary. */
function expensive(i?: Instruction): boolean {
  if (!i || !EXPENSIVE.has(i.opcode)) return false;
  return i.opcode !== "mul" || i.operands.every((operand) => operand.startsWith("%"));
}

/** A pair's quota of cuts: one per expensive operation and loop both sides hold. */
export function quota(src: Instruction[], tgt: Instruction[]): number {
  const count = (body: Instruction[]) => body.filter((i) => expensive(i)).length;
  return Math.min(count(src) + headers(src).length, count(tgt) + headers(tgt).length);
}

/** Where `body`'s own instructions begin, past the ones stating what its goal assumes. */
export function firstOwn(body: Instruction[]): number {
  const users = new Map(body.map((i) => [i.value, [] as Instruction[]]));
  for (const i of body) for (const operand of i.operands) users.get(operand)?.push(i);
  const stating = new Set<Instruction>();
  for (const i of [...body].reverse()) {
    const uses = users.get(i.value) ?? [];
    const states = uses.length > 0 && uses.every((user) => stating.has(user));
    if (i.calls === "@llvm.assume" || states) stating.add(i);
  }
  const own = body.findIndex((i) => !stating.has(i));
  return own < 0 ? body.length : own;
}

/** What a run learns at its cuts, for the cuts after them. */
export interface Learned {
  /** The predicates each goal assumes at its entry, by goal. */
  assumed: Map<string, Predicate[]>;
  /** The contract the last cut of a loop landed, by the types of the values it passes. */
  loops: Map<string, StrengthenContract>;
}

/** What a run knows before its first cut. */
export function learning(): Learned {
  return { assumed: new Map(), loops: new Map() };
}

/** One cut of goal `gid`, or nothing when the framework refuses it or a value has no match. */
export async function cut(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  srcCut: string,
  tgtCut: string,
  learned: Learned = learning(),
) {
  const preview = await session.splitPreview(gid, srcCut, tgtCut);
  if (preview.kind !== "preview") return undefined;
  const [src, tgt] = await bodies(session, llops, gid);
  const map = valueMap(preview.params, preview.tgtParams ?? [], src, tgt, tgtCut);
  if (!map) return undefined;
  const split = await session.split(gid, srcCut, tgtCut, map);
  if (split.kind !== "split") return undefined;
  if (!(await fillCut(session, llops, split))) {
    await session.unsplit(gid);
    return undefined;
  }
  const view = await session.show(gid);
  const lives = split.params.map((param) => param.live);
  const images = split.params.map(({ live, tgt }) => (live === "poison" ? tgt : map[live]));
  const [srcLoop, tgtLoop] = split.detach?.hypothesis ? [srcCut, tgtCut] : [];
  const sides: [Side, Side] = [
    { module: view.src.text, point: pointOf(src, srcCut), values: lives, loop: srcLoop },
    { module: view.tgt.text, point: pointOf(tgt, tgtCut), values: images, loop: tgtLoop },
  ];
  if (split.detach?.hypothesis) {
    await unfoldToMatch(session, llops, split, sides, limits.unfolds);
  }
  // The outer keeps the goal's entry, so it assumes what the goal assumes.
  const inherited = learned.assumed.get(gid) ?? [];
  learned.assumed.set(split.children.outer, inherited);
  if (limits.facts) {
    const landed = await strengthenSplit(session, llops, gid, split, sides, learned);
    learned.assumed.set(split.children.callee, landed);
  }
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
  tgtCut: string,
) {
  const { pairs } = diff(src, tgt);
  const own = new Set(src.flatMap((i) => (i.value ? [i.value] : [])));
  const blockOf = new Map<string, string>();
  for (const i of tgt) if (i.value) blockOf.set(i.value, i.block);
  // At a cut block, a partner that does not reach it on every path arrives through a phi.
  const at = (value: string) => {
    const block = blockOf.get(value);
    if (!block || tgtCut.startsWith("#") || dominates(tgt, block, tgtCut)) return value;
    const phi = tgt.find((i) => i.block === tgtCut && i.phi && i.operands.includes(value));
    return phi?.value;
  };
  const map: Record<string, string> = {};
  for (const { live } of params) {
    const partner = own.has(live) ? pairs.get(live) : live;
    if (!partner) return undefined;
    map[live] = at(partner) ?? partner;
  }
  const passed = new Set(Object.values(map));
  for (const { live } of tgtParams) if (!passed.has(live)) map[`tgt${live}`] = live;
  return map;
}

/** Strengthens `split` with what its goal, the analyses, relations and guesses offer. */
async function strengthenSplit(
  session: Session,
  llops: Llops,
  gid: string,
  split: Extract<SplitResult, { kind: "split" }>,
  [mine, theirs]: [Side, Side],
  { assumed, loops }: Learned,
) {
  const lives = split.params.map((param) => param.live);
  const facts = await cutFacts(llops, mine.module, mine.point, lives);
  const types = split.params.map((param) => param.type);
  const relations = { predicates: await relationsAt(llops, [mine, theirs], types) };
  const loop = split.detach?.hypothesis !== undefined;
  // At a loop's header, what the tgt knows is a guess the src's iteration may keep too.
  const known = loop ? await predicatesAt(llops, theirs) : [];
  const guesses = loop ? union(guessInvariants(split.params), { predicates: known }) : {};
  const own = { predicates: passedOn(assumed.get(gid) ?? [], lives) };
  const candidates = union(guesses, facts, relations, own);
  if (!loop) return strengthenCut(session, gid, candidates);
  // A stage walk cuts the same loop again in each step goal.
  const key = types.join("\0");
  const landed = await strengthenLoop(session, gid, candidates, loops.get(key));
  if (landed) loops.set(key, landed);
  return landed?.predicates ?? [];
}

/**
 * Where the values a cut passes are analyzed: before the instruction it cuts
 * at, or before the first instruction of the block it cuts at that is not a
 * phi, where the facts hold however the block is entered.
 */
function pointOf(src: Instruction[], at: string): string {
  return at.startsWith("#") ? at : `#${src.findIndex((i) => i.block === at && !i.phi)}`;
}

/** Cuts goal `gid` where its first loop must be cut, if it loops. */
export async function cutLoop(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  learned?: Learned,
) {
  const at = loopCut(...(await bodies(session, llops, gid)));
  return at ? cut(session, llops, gid, limits, ...at, learned) : undefined;
}

/**
 * Where to cut just before the last expensive operations both sides apply,
 * latest first, so that each reads the same operands, parameters of the callee.
 */
export function beforePoints(src: Instruction[], tgt: Instruction[]): [string, string][] {
  const { regions, pairs } = diff(src, tgt);
  // Instructions both sides apply: partners outside the regions, or values the diff pairs.
  const shared = new Map(partners(src, tgt, regions));
  const at = new Map(tgt.flatMap((i, j) => (i.value ? [[i.value, j] as const] : [])));
  src.forEach((i, k) => {
    const j = at.get(pairs.get(i.value ?? "") ?? "");
    if (j !== undefined) shared.set(k, j);
  });
  // With only the goal's assumptions before it, a cut leaves the goal as its callee.
  const own = firstOwn(src);
  return [...shared]
    .filter(([i, j]) => i > own && expensive(src[i]) && src[i]?.opcode === tgt[j]?.opcode)
    .sort(([a], [b]) => b - a)
    .slice(0, TRIES)
    .map(([i, j]) => [`#${i}`, `#${j}`]);
}

/** How many expensive operations a cut before `body[k]` moves: all that it reaches. */
function moved(body: Instruction[], k: number): number {
  const next = successors(body);
  const block = body[k]?.block ?? "";
  const reached = new Set(next.get(block));
  for (const from of reached) for (const to of next.get(from) ?? []) reached.add(to);
  // On a branch, what a point reaches is no suffix of the listed instructions.
  const after = (m: number) => m >= k && body[m]?.block === block;
  return body.filter((i, m) => expensive(i) && (after(m) || reached.has(i.block))).length;
}

/**
 * Where both sides agree and their expensive operations split most evenly,
 * most even first, leaving at least one in each half.
 */
export function balancedPoints(src: Instruction[], tgt: Instruction[]): [string, string][] {
  const { regions } = diff(src, tgt);
  const total = src.filter((i) => expensive(i)).length;
  const kept = (k: number) => total - moved(src, k);
  return [...partners(src, tgt, regions)]
    .filter(([i, j]) => i > 0 && j >= 0 && !src[i]?.phi && !tgt[j]?.phi)
    .map(([i, j]) => ({ i, j, gap: Math.abs(total - 2 * kept(i)), split: kept(i) }))
    .filter((point) => point.split > 0 && point.split < total)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, TRIES)
    .map(({ i, j }) => [`#${i}`, `#${j}`]);
}
