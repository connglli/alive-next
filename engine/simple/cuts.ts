// Cuts a goal in two at a point both sides share, passing each value that
// crosses it as its matched tgt value, and strengthens the cut
// with the facts the analyses know about those values, keeping the ones that
// hold. A cut at the header of a loop leaves one iteration, whose back edge
// calls the hypothesis, so the goals it leaves prove by induction, and it is
// strengthened with the invariants Houdini finds among those facts and some
// guesses. A cut before an expensive operation hands it the same operands on
// both sides, and a balanced cut divides a goal's expensive operations between
// its halves.
import type { Attrs, Instruction, Llops, OutlineParam, Predicate } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { CutResult } from "../core/state/cuts.ts";
import { tested } from "./cases.ts";
import { cutFacts, passedOn, predicatesAt, strengthenCut, union } from "./facts.ts";
import { fillCut } from "./fill.ts";
import type { Limits } from "./limits.ts";
import {
  blockCut,
  copyShared,
  entryFirst,
  guessInvariants,
  loopCut,
  strengthenLoop,
  unfoldToMatch,
} from "./loops.ts";
import { stepPhis } from "./phis.ts";
import { diff, dominates, headers, storedAt, successors } from "./regions.ts";
import { relationsAt, type Side } from "./relations.ts";
import { unbrokenByRuns } from "./runs.ts";
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

/** The predicates each goal assumes at its entry, by goal. */
export type Assumed = Map<string, Predicate[]>;

/** One cut of goal `gid`, or nothing when the framework refuses it or a value has no match. */
export async function cut(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  srcCut: string,
  tgtCut: string,
  assumed: Assumed = new Map(),
  matches?: ReadonlyMap<string, string>,
) {
  const preview = await session.cutPreview(gid, srcCut, tgtCut);
  if (preview.kind !== "preview") return undefined;
  const [src, tgt] = await bodies(session, llops, gid);
  const { pairs } = diff(src, tgt);
  for (const [source, target] of matches ?? []) pairs.set(source, target);
  const slots = new Set(preview.slots?.src ?? []);
  const held = preview.params.map(({ live }, k) =>
    slots.has(k) ? heldAt(src, tgt, pairs, live, srcCut) : undefined,
  );
  const partners = held.map((slot) => slot?.partner);
  const map = valueMap(preview.params, partners, preview.tgtParams ?? [], pairs, src, tgt, tgtCut);
  if (!map) return undefined;
  const made = await session.cut(gid, srcCut, tgtCut, map);
  if (made.kind !== "cut") return undefined;
  const view = await session.show(gid);
  const lives = made.params.map(({ live }, k) => held[k]?.read ?? live);
  const images = made.params.map(({ live, tgt }) => (live === "poison" ? tgt : map[live]));
  const [srcLoop, tgtLoop] = made.detach?.hypothesis ? [srcCut, tgtCut] : [];
  const sides: [Side, Side] = [
    { module: view.src.text, point: pointOf(src, srcCut), values: lives, loop: srcLoop },
    { module: view.tgt.text, point: pointOf(tgt, tgtCut), values: images, loop: tgtLoop },
  ];
  const unfolded = made.detach?.hypothesis
    ? await unfoldToMatch(session, llops, made, sides, limits.unfolds)
    : false;
  if (!(await fillCut(session, llops, made))) {
    await session.uncut(gid);
    return undefined;
  }
  // The outer keeps the goal's entry, so it assumes what the goal assumes.
  const inherited = assumed.get(gid) ?? [];
  assumed.set(made.children.outer, inherited);
  if (limits.facts) {
    const landed = await strengthenNewCut(session, llops, gid, made, sides, inherited, unfolded);
    assumed.set(made.children.callee, landed);
    await strengthenReturns(session, llops, gid, sides);
  }
  return made.children;
}

/** Strengthens the cut at `gid` with what the tgt's return states and the src's does not. */
async function strengthenReturns(
  session: Session,
  llops: Llops,
  gid: string,
  [src, tgt]: [Side, Side],
) {
  const [mine, theirs] = await Promise.all([
    returnFacts(llops, src.module),
    returnFacts(llops, tgt.module),
  ]);
  const owed = Object.entries(theirs).filter(
    ([name, fact]) => JSON.stringify(mine[name]) !== JSON.stringify(fact),
  );
  if (owed.length > 0) await session.strengthen(gid, { ret_attrs: Object.fromEntries(owed) });
}

/** The facts on the return of `module`'s function that make a value outside them poison. */
export async function returnFacts(llops: Llops, module: string): Promise<Attrs> {
  const shape = await llops.validate(module);
  const fn = Object.values((shape.ok && shape.functions) || {}).find((f) => f.defined);
  // The signature spells the return's attributes before its type.
  const said = fn?.signature.slice(0, fn.signature.indexOf(`${fn.return_type}(`)) ?? "";
  const [min, max] = (said.match(/range\(i\d+ (-?\d+), (-?\d+)\)/) ?? []).slice(1).map(Number);
  const align = Number(said.match(/\balign (\d+)/)?.[1]);
  const exact = [min, max].every((bound) => Number.isSafeInteger(bound));
  return {
    ...(exact ? { range: { min, max } } : {}),
    ...(/\bnonnull\b/.test(said) ? { nonnull: true } : {}),
    ...(align ? { align } : {}),
  };
}

/**
 * The tgt partner of each value the src passes, and each tgt value the src
 * lacks under a key no src value has, or nothing when a src value has none.
 */
function valueMap(
  params: OutlineParam[],
  held: (string | undefined)[],
  tgtParams: OutlineParam[],
  pairs: Map<string, string>,
  src: Instruction[],
  tgt: Instruction[],
  tgtCut: string,
) {
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
  for (const [k, { live }] of params.entries()) {
    // A slot pairs with the tgt's own slot, or else with what the tgt holds in it.
    const partner = (own.has(live) ? pairs.get(live) : live) ?? held[k];
    if (!partner) return undefined;
    map[live] = partner === "poison" ? partner : (at(partner) ?? partner);
  }
  const passed = new Set(Object.values(map));
  for (const { live } of tgtParams) if (!passed.has(live)) map[`tgt${live}`] = live;
  return map;
}

/** The value stack slot `slot` holds at the cut, with its tgt partner, or poison. */
function heldAt(
  src: Instruction[],
  tgt: Instruction[],
  pairs: Map<string, string>,
  slot: string,
  cut: string,
): { read: string; partner?: string } {
  const reads = readsAt(src, slot, cut);
  if (reads.length === 0) return { read: "poison", partner: "poison" };
  const theirs = new Map(tgt.flatMap((i) => (i.value ? [[i.value, i] as const] : [])));
  const type = src.find((i) => i.value === reads[0])?.type;
  // A partner holds a value of the load's type, where the tgt says which type.
  const fits = (it?: string) => it?.startsWith("%") && (theirs.get(it)?.type ?? type) === type;
  // A matched user of the load reads its partner at the same place in the tgt.
  const readBy = (read: string) => {
    for (const user of src) {
      const k = user.operands.indexOf(read);
      const other = k >= 0 && user.value ? theirs.get(pairs.get(user.value) ?? "") : undefined;
      if (!other || other.opcode !== user.opcode) continue;
      const agree = (x: string, j: number) => j === k || (pairs.get(x) ?? x) === other.operands[j];
      const it = !user.commutative || user.operands.every(agree) ? other.operands[k] : undefined;
      if (fits(it)) return it;
    }
    return fits(pairs.get(read)) ? pairs.get(read) : undefined;
  };
  // A slot holds what the store that comes last on every path to the cut put there.
  const stored = storedAt(src, slot, Number(pointOf(src, cut).slice(1)), type ?? "");
  const partner = stored && (src.some((i) => i.value === stored) ? pairs.get(stored) : stored);
  if (stored && fits(partner)) return { read: stored, partner };
  const paired = reads.map((read) => ({ read, partner: readBy(read) }));
  return paired.find(({ partner }) => partner) ?? { read: reads[0] ?? "poison" };
}

/** The loads of stack slot `slot` a path from `cut` uses before it stores into the slot. */
function readsAt(src: Instruction[], slot: string, cut: string): string[] {
  const used = new Set(src.flatMap((i) => i.operands));
  const next = successors(src);
  const first = (block: string) => src.findIndex((i) => i.block === block);
  const entered = new Set<string>();
  const reads: string[] = [];
  const todo = [cut.startsWith("#") ? Number(cut.slice(1)) : first(cut)];
  for (let k = todo.pop(); k !== undefined; k = todo.pop()) {
    const block = src[k]?.block;
    let stored = false;
    for (; !stored && block !== undefined && src[k]?.block === block; k++) {
      const i = src[k] as Instruction;
      const read = i.opcode === "load" && i.operands[0] === slot && i.value;
      if (read && used.has(read)) reads.push(read);
      stored = i.opcode === "store" && i.operands[1] === slot;
    }
    for (const to of stored || !block ? [] : (next.get(block) ?? []))
      if (!entered.has(to)) {
        entered.add(to);
        todo.push(first(to));
      }
  }
  return reads;
}

/** Strengthens cut `made` with what its goal, the analyses, relations and guesses offer. */
async function strengthenNewCut(
  session: Session,
  llops: Llops,
  gid: string,
  made: Extract<CutResult, { kind: "cut" }>,
  [mine, theirs]: [Side, Side],
  inherited: Predicate[],
  unfolded: boolean,
) {
  const lives = mine.values.map((value = "") => value);
  const facts = await cutFacts(llops, mine.module, mine.point, lives);
  const types = made.params.map((param) => param.type);
  const relations = { predicates: await relationsAt(llops, [mine, theirs], types) };
  const loop = made.detach?.hypothesis !== undefined;
  // At a loop's header, what the tgt knows is a guess the src's iteration may keep too.
  const known = loop ? await predicatesAt(llops, theirs) : [];
  const guards = loop ? tested(...(await bodies(session, llops, made.children.callee))) : [];
  const guesses = loop ? union(guessInvariants(made.params, guards), { predicates: known }) : {};
  const own = { predicates: passedOn(inherited, lives) };
  const candidates = union(guesses, facts, relations, own);
  if (!loop) return strengthenCut(session, gid, candidates);
  // Runs serve only an iteration that loops, since its preview reaches four inner
  // iterations, and not an unfolded src, whose callee is entered at fewer visits.
  const iteration = await llops.validate((await session.show(made.children.callee)).src.text);
  const unbroken =
    iteration.ok && iteration.cyclic && !unfolded && mine.loop
      ? await unbrokenByRuns(session, llops, gid, mine.loop, made.params, candidates)
      : candidates;
  return strengthenLoop(session, gid, unbroken);
}

/**
 * Where the values a cut passes are analyzed: before the instruction it cuts
 * at, or before the first instruction of the block it cuts at that is not a
 * phi, where the facts hold however the block is entered.
 */
function pointOf(src: Instruction[], at: string): string {
  return at.startsWith("#") ? at : `#${src.findIndex((i) => i.block === at && !i.phi)}`;
}

/** Cuts goal `gid` at `point`, or first where outside code joins what the point reaches. */
export async function cutAt(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  point: [string, string],
  assumed?: Assumed,
) {
  const first = joinFirst(...(await bodies(session, llops, gid)), point);
  return first ? cut(session, llops, gid, limits, ...first, assumed) : undefined;
}

/**
 * Where to cut for instruction `point`: there, or at the block where outside
 * code joins what it reaches on either side, as a loop is cut at its header.
 */
export function joinFirst(
  src: Instruction[],
  tgt: Instruction[],
  [srcCut, tgtCut]: readonly [string, string],
) {
  const blockAt = (body: Instruction[], at: string) => body[Number(at.slice(1))]?.block ?? "";
  const [mine, theirs] = [blockAt(src, srcCut), blockAt(tgt, tgtCut)];
  if (entryFirst(src, mine) !== mine) return blockCut(src, tgt, mine);
  const join = entryFirst(tgt, theirs);
  if (join === theirs) return [srcCut, tgtCut] as const;
  const partner = [...diff(src, tgt).pairs].find(([, other]) => other === join)?.[0];
  return partner ? blockCut(src, tgt, partner) : undefined;
}

/** Cuts goal `gid` where its first loop must be cut, if it loops. */
export async function cutLoop(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  assumed?: Assumed,
) {
  if (limits.steps) await copyShared(session, llops, gid);
  const body = await bodies(session, llops, gid);
  const at = loopCut(...body);
  if (!at) return undefined;
  const views = limits.steps ? await stepPhis(session, llops, gid, body, at) : undefined;
  return cut(
    session,
    llops,
    gid,
    limits,
    views?.source ?? at[0],
    views?.target ?? at[1],
    assumed,
    views?.matches,
  );
}

/**
 * Where to cut just before the last expensive operations both sides apply,
 * latest first, so that each reads the same operands, parameters of the callee.
 */
export function beforePoints(src: Instruction[], tgt: Instruction[]): [string, string][] {
  const { regions, pairs } = diff(src, tgt);
  // Match through the diff first, then through the form and paired operands.
  const shared = new Map(partners(src, tgt, regions));
  const at = new Map(tgt.flatMap((i, j) => (i.value ? [[i.value, j] as const] : [])));
  const defined = new Set(src.flatMap((i) => i.value ?? []));
  src.forEach((i, k) => {
    const j = at.get(pairs.get(i.value ?? "") ?? "");
    if (j !== undefined) shared.set(k, j);
    if (shared.has(k) || !expensive(i)) return;
    const reads = i.operands.map((value) => (defined.has(value) ? pairs.get(value) : value));
    const matches = tgt.flatMap((other, n) =>
      i.form === other.form &&
      reads.length === other.operands.length &&
      other.operands.every((value, m) => value === reads[m])
        ? [n]
        : [],
    );
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) shared.set(k, only);
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
 * Where both sides agree and their expensive operations divide most evenly,
 * most even first, leaving at least one in each half.
 */
export function balancedPoints(src: Instruction[], tgt: Instruction[]): [string, string][] {
  const { regions } = diff(src, tgt);
  const total = src.filter((i) => expensive(i)).length;
  const kept = (k: number) => total - moved(src, k);
  return [...partners(src, tgt, regions)]
    .filter(([i, j]) => i > 0 && j >= 0 && !src[i]?.phi && !tgt[j]?.phi)
    .map(([i, j]) => ({ i, j, gap: Math.abs(total - 2 * kept(i)), kept: kept(i) }))
    .filter((point) => point.kept > 0 && point.kept < total)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, TRIES)
    .map(({ i, j }) => [`#${i}`, `#${j}`]);
}
