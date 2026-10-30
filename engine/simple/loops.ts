// Loops: where a goal that loops is cut, and the invariants that cut keeps. It
// is cut at its first header, or first at a join it shares with outside code,
// once that code has its own copy of each block it enters that holds no loop, as
// a rotated loop's guard enters its exit. The
// cut's candidates include guessed invariants, and Houdini narrows them: each
// round previews the strengthen and keeps what holds where the loop is entered
// and what one iteration keeps with the rest assumed. When a round drops
// nothing, the strengthen proves that what is left is inductive.
import type { Comparison, Instruction, Llops, OutlineParam } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { CutResult } from "../core/state/cuts.ts";
import type { StrengthenContract } from "../core/state/strengthen.ts";
import { comparisons, noundefLost, size } from "./facts.ts";
import { diff, headers, reaches, successors } from "./regions.ts";
import { expressionsAt, type Side } from "./relations.ts";
import { bodies } from "./windows.ts";

/** Copies shared acyclic blocks reached by each side's first loop. */
export async function copyShared(session: Session, llops: Llops, gid: string): Promise<void> {
  for (const side of ["src", "tgt"] as const)
    await copyInto(session, llops, gid, side, (body) => headers(body)[0]);
}

/** Copies the first header for its entry edges when both sides have loops. */
export async function copyHeader(
  session: Session,
  llops: Llops,
  gid: string,
  side: "src" | "tgt",
): Promise<boolean> {
  const body = await bodies(session, llops, gid);
  if (body.some((instructions) => headers(instructions).length === 0)) return false;
  const mine = body[side === "src" ? 0 : 1];
  const header = headers(mine)[0];
  if (!header) return false;
  const next = successors(mine);
  const preds = [...next].flatMap(([from, tos]) =>
    tos.includes(header) && !reaches(next, header, from) ? [from] : [],
  );
  return preds.length > 0 && copied(session, gid, side, { block: header, preds });
}

/** Copies shared acyclic blocks for paths outside the region `pick` reaches. */
export async function copyInto(
  session: Session,
  llops: Llops,
  gid: string,
  side: "src" | "tgt",
  pick: (body: Instruction[]) => string | undefined,
): Promise<void> {
  const k = side === "src" ? 0 : 1;
  const blocks = new Set((await bodies(session, llops, gid))[k].map((i) => i.block));
  for (let left = blocks.size; left > 0; left--) {
    const body = (await bodies(session, llops, gid))[k];
    const header = pick(body);
    const shared = header && sharedWith(body, header);
    if (!shared || !(await copied(session, gid, side, shared))) break;
  }
}

/** A shared acyclic block reached by `header`, with its outside predecessors. */
function sharedWith(body: Instruction[], header: string) {
  const next = successors(body);
  const reached = new Set([header]);
  for (const from of reached) for (const to of next.get(from) ?? []) reached.add(to);
  for (const block of reached) {
    const preds = [...next].flatMap(([from, tos]) =>
      !reached.has(from) && tos.includes(block) ? [from] : [],
    );
    if (block === header || preds.length === 0) continue;
    // A copy of a block in a cycle still leads back into the cycle, so
    // repeated copies would only peel iterations without isolating it.
    if ((next.get(block) ?? []).some((to) => reaches(next, to, block))) continue;
    return { block, preds };
  }
  return undefined;
}

/** Whether copying `block` for `preds` on `side` of goal `gid` is certified. */
async function copied(
  session: Session,
  gid: string,
  side: "src" | "tgt",
  { block, preds }: { block: string; preds: string[] },
) {
  await session.begin(gid, side);
  if ((await session.edit({ op: "copy_block", block, preds })).kind !== "applied") {
    await session.abort();
    return false;
  }
  return (await session.commit({ narrow: false, eager: false })).kind === "certified";
}

/** Where to cut a goal that loops, as a src block and its tgt partner. */
export function loopCut(src: Instruction[], tgt: Instruction[]) {
  const header = headers(src)[0];
  return header ? blockCut(src, tgt, header) : undefined;
}

/** Where to cut to detach src `block`, as a src block and its tgt partner. */
export function blockCut(src: Instruction[], tgt: Instruction[], block: string) {
  const { pairs } = diff(src, tgt);
  const at = entryFirst(src, block);
  const partner = pairs.get(at);
  if (!partner) return undefined;
  // The tgt may have to be cut first where the src need not, as at a peeled loop's exit.
  const first = entryFirst(tgt, partner);
  if (first === partner) return [at, partner] as const;
  const mine = [...pairs].find(([, theirs]) => theirs === first)?.[0];
  return mine ? ([mine, first] as const) : undefined;
}

/**
 * Unfolds loop cut `made` up to `budget` times where its counters say one side
 * lags, and answers whether it unfolded the src.
 */
export async function unfoldToMatch(
  session: Session,
  llops: Llops,
  made: Extract<CutResult, { kind: "cut" }>,
  sides: Side[],
  budget: number,
): Promise<boolean> {
  const counters = await Promise.all(sides.map((side) => countersAt(llops, side)));
  const [mine = [], theirs = []] = counters;
  const { outer, callee } = made.children;
  // Each unfold of an iteration doubles what it runs, so only a power of two matches.
  const [r = 0, ...ratios] = agreeing(mine, theirs, (a, b) => ratio(a.step, b.step));
  const doublings = ratios.length === 0 ? Math.log2(Math.abs(r)) : NaN;
  const unrolls = Number.isInteger(doublings) && doublings <= budget ? doublings : 0;
  for (let n = 0; n < unrolls; n++)
    if (!(await unfolded(session, callee, r > 0 ? "src" : "tgt"))) return r > 0;
  const src = unrolls > 0 && r > 0;
  // Each unfold of an outer runs one more iteration before the loop, as peeling does.
  const [d = 0, ...gaps] = agreeing(mine, theirs, behind);
  const peels = gaps.length === 0 && Math.abs(d) <= budget - unrolls ? Math.abs(d) : 0;
  for (let n = 0; n < peels; n++)
    if (!(await unfolded(session, outer, d > 0 ? "src" : "tgt"))) return src || d > 0;
  return src || (peels > 0 && d > 0);
}

/** How far an iteration that loops is run to break a candidate. */
const UNROLL = 4;

/** Strengthens loop cut `gid` with the inductive part of `candidates`. */
export async function strengthenLoop(
  session: Session,
  gid: string,
  candidates: StrengthenContract,
) {
  let kept = candidates;
  while (size(kept) > 0) {
    const preview = await session.strengthenPreview(gid, kept, UNROLL);
    if (preview.kind !== "preview") return [];
    if (size(preview.holds) === size(kept)) break;
    const lost = noundefLost(kept, preview.holds);
    kept = { ...preview.holds, param_attrs: { ...preview.holds.param_attrs, ...lost } };
  }
  if (size(kept) === 0) return [];
  const landed = (await session.strengthen(gid, kept)).kind === "strengthened";
  return landed ? (kept.predicates ?? []) : [];
}

/** Guesses invariants about `params` from Houdini's templates. */
export function guessInvariants(
  params: OutlineParam[],
  guards: Comparison[] = [],
): StrengthenContract {
  // Templates: Parameter x parameter comparisons, and parameter x itself comparisons.
  const predicates = comparisons(params.map((param) => param.type));
  for (const guard of guards) {
    const [lhs, rhs] =
      typeof guard.lhs === "number" ? [guard.rhs, guard.lhs] : [guard.lhs, guard.rhs];
    if (typeof lhs !== "string" || typeof rhs !== "number") continue;
    // An invariant must also hold at the bound where the loop exits.
    for (const op of ["ule", "uge", "sle", "sge"] as const) predicates.push({ op, lhs, rhs });
  }
  // Template: Each parameter neither undef nor poison.
  const noundef = Object.fromEntries(params.map((_, i) => [i, { noundef: true }]));
  return { param_attrs: noundef, predicates };
}

/** Where to cut to detach `block`: itself, or first where outside code enters its reach. */
export function entryFirst(body: Instruction[], block: string, seen = new Set<string>()): string {
  const next = successors(body);
  const reached = new Set([block]);
  for (const from of reached) for (const to of next.get(from) ?? []) reached.add(to);
  const outside = [...next].flatMap(([from, tos]) => (reached.has(from) ? [] : tos));
  const entry = outside.find((to) => to !== block && reached.has(to));
  if (!entry || seen.has(entry)) return block;
  return entryFirst(body, entry, seen.add(block));
}

/** A counter of a loop: its step per iteration, and its start where that is a constant. */
interface Counter {
  start?: bigint;
  step: bigint;
}

/** Each parameter on `side` as a counter of its loop, where it is one. */
async function countersAt(llops: Llops, side: Side): Promise<(Counter | undefined)[]> {
  return (await expressionsAt(llops, side)).map((tree) => {
    const ofLoop = tree?.op === "addrec" && tree.loop === side.loop;
    const [start, step, ...more] = ofLoop ? (tree?.operands ?? []) : [];
    const counts = step?.op === "const" && step.value && step.value !== "0" && !more.length;
    if (!counts || !step?.value) return undefined;
    const fixed = start?.op === "const" && start.value ? BigInt(start.value) : undefined;
    return { start: fixed, step: BigInt(step.value) };
  });
}

/** The distinct values `of` gives the parameters that count on both sides. */
function agreeing(
  mine: (Counter | undefined)[],
  theirs: (Counter | undefined)[],
  of: (src: Counter, tgt: Counter) => number | undefined,
): number[] {
  const values = mine.flatMap((a, k) => {
    const b = theirs[k];
    const value = a && b ? of(a, b) : undefined;
    return value === undefined ? [] : [value];
  });
  return [...new Set(values)];
}

/** How many steps ahead the tgt's counter starts, when its step equals the src's. */
function behind(src: Counter, tgt: Counter): number | undefined {
  const starts = src.start !== undefined && tgt.start !== undefined;
  if (!starts || src.step !== tgt.step) return undefined;
  const gap = (tgt.start ?? 0n) - (src.start ?? 0n);
  return gap % src.step === 0n ? Number(gap / src.step) : undefined;
}

/** Whether an unfold of `side` of goal `gid` landed. */
async function unfolded(session: Session, gid: string, side: "src" | "tgt") {
  return (await session.unfold(gid, side)).kind === "certified";
}

/** How many src iterations one tgt iteration runs, as k or as -k when the reverse, or 0. */
function ratio(src: bigint, tgt: bigint): number {
  if (tgt % src === 0n && tgt / src > 0n) return Number(tgt / src);
  if (src % tgt === 0n && src / tgt > 0n) return -Number(src / tgt);
  return 0;
}
