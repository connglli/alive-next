// Steps a goal's src toward its tgt one region at a time. For each region,
// the `splice` edit puts the tgt's code in place of the src's, wired through
// the values the diff pairs. The commit names the region as its window. When
// alive2 refuses, the window grows backward over the instructions that define
// the values either side reads, and last, the window is tried again with what
// the analyses know about those values.
import type { Instruction, Llops, Predicate } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { factsAt } from "./facts.ts";
import type { Limits } from "./limits.ts";
import { diff, isTerminator, type Region, regions } from "./regions.ts";
import { relationsAt } from "./relations.ts";

/** A goal being stepped, toward its tgt unless `toward` names another program. */
interface Run {
  session: Session;
  llops: Llops;
  gid: string;
  limits: Limits;
  toward?: string;
  /** For each src value, the tgt value the diff pairs it with. */
  pairs: Map<string, string>;
}

/**
 * Commits each region a window can hold, last to first so that no step moves
 * one still to come, and returns the regions left.
 */
export async function stepWindows(
  session: Session,
  llops: Llops,
  gid: string,
  limits: Limits,
  toward?: string,
): Promise<Region[]> {
  const [src, tgt] = await bodies(session, llops, gid, toward);
  const { regions: found, pairs } = diff(src, tgt);
  const run = { session, llops, gid, limits, toward, pairs };
  const across = partners(src, tgt, found);
  for (const region of [...found].reverse()) {
    const at = region.src.length && region.tgt.length ? region : widened(src, tgt, region, across);
    if (at?.window) await step(run, at, floor(src, found, at));
  }
  return regions(...(await bodies(session, llops, gid, toward)));
}

/** The tgt partner of each src instruction outside every region; they pair one to one, in order. */
export function partners(
  src: Instruction[],
  tgt: Instruction[],
  found: Region[],
): Map<number, number> {
  const [mine, theirs] = [
    new Set(found.flatMap((r) => r.src)),
    new Set(found.flatMap((r) => r.tgt)),
  ];
  const outside = [
    src.map((_, i) => i).filter((i) => !mine.has(i)),
    tgt.map((_, j) => j).filter((j) => !theirs.has(j)),
  ];
  return new Map(outside[0]?.map((i, k) => [i, outside[1]?.[k] ?? -1]));
}

/** A deletion or insertion widened by a shared neighbour, so both windows hold something. */
function widened(
  src: Instruction[],
  tgt: Instruction[],
  region: Region,
  across: Map<number, number>,
) {
  const back = new Map([...across].map(([i, j]) => [j, i]));
  const own = region.src.length > 0 ? region.src : region.tgt;
  const block = (region.src.length > 0 ? src : tgt)[own[0] ?? -1]?.block;
  for (const k of [(own[0] ?? 0) - 1, (own.at(-1) ?? 0) + 1]) {
    const [i, j] = region.src.length > 0 ? [k, across.get(k)] : [back.get(k), k];
    const [s, t] = [src[i ?? -1], tgt[j ?? -1]];
    if (i === undefined || j === undefined || !s || !t || s.phi || isTerminator(s)) continue;
    if ((region.src.length > 0 ? s : t).block !== block) continue;
    const sorted = (xs: number[], x: number) => [...xs, x].sort((a, b) => a - b);
    return { src: sorted(region.src, i), tgt: sorted(region.tgt, j), window: true };
  }
  return undefined;
}

/** The numbered bodies of a goal's src and its tgt, or of the program it is stepped toward. */
export async function bodies(
  session: Session,
  llops: Llops,
  gid: string,
  toward?: string,
): Promise<[Instruction[], Instruction[]]> {
  const view = await session.show(gid);
  const [src, tgt] = await Promise.all([
    llops.number(view.src.text),
    llops.number(toward ?? view.tgt.text),
  ]);
  if (!src.ok || !tgt.ok) throw new Error(`cannot number the sides of ${gid}`);
  return [src.body, tgt.body];
}

/**
 * How far back a window may grow: to its block's start or the previous region,
 * since the two sides agree up to there.
 */
function floor(src: Instruction[], found: Region[], region: Region): number {
  const first = region.src[0] ?? 0;
  const block = src[first]?.block;
  let start = first;
  while (start > 0 && src[start - 1]?.block === block) start--;
  for (const other of found) {
    const last = other.src.at(-1) ?? -1;
    if (last < first && last >= start) start = last + 1;
  }
  return start;
}

/** Certifies one region as a step: its window, then grown windows, then its window with facts. */
async function step(run: Run, region: Region, floor: number) {
  let at: Region | undefined = region;
  for (let layer = 0; at && layer <= run.limits.growth; layer++) {
    const tried = await attempt(run, at, false);
    if (tried.certified || !tried.reads || !run.limits.windows) return tried.certified;
    const numbered = await run.llops.number((await run.session.show(run.gid)).src.text);
    at = numbered.ok ? grown(numbered.body, at, tried.reads, floor) : undefined;
  }
  return run.limits.facts && (await attempt(run, region, true)).certified;
}

/** One commit of a region's window, with facts about what it reads when asked. */
async function attempt(run: Run, at: Region, withFacts: boolean) {
  const { session, llops, gid } = run;
  const view = await session.show(gid);
  const tgtText = run.toward ?? view.tgt.text;
  const [src, tgt] = await bodies(session, llops, gid, run.toward);
  const wiring = wire(src, tgt, at, run.pairs);
  if (!wiring) return { certified: false };
  const { map, reads } = wiring;
  const from = `#${at.src[0]}`;
  const text = view.src.text;
  const preconditions = withFacts ? await factsAt(llops, text, from, reads) : {};
  const predicates = withFacts ? await relatedReads(llops, text, from, reads, src) : [];
  const known = Object.keys(preconditions).length > 0;
  if (withFacts && !known && predicates.length === 0) return { certified: false, reads };
  await session.begin(gid, "src");
  const edited = await session.edit({
    op: "splice",
    from,
    to: `#${at.src.at(-1)}`,
    with: { module: tgtText, from: `#${at.tgt[0]}`, to: `#${at.tgt.at(-1)}` },
    value_map: map,
  });
  // A replaced value used later that has no partner refuses the splice, and a
  // wider window may hold the instructions that use it.
  if (edited.kind === "refused") {
    await session.abort();
    return { certified: false, reads };
  }
  // The whole function is what windows avoid, so it is not asked, after the
  // window or after the step; with windows off, it is the only question.
  const window = { from, to: `#${at.src.at(-1)}` };
  const given = {
    ...(known ? { preconditions } : {}),
    ...(predicates.length ? { predicates } : {}),
  };
  const options = run.limits.windows
    ? { window, whole: false, eager: false, ...given }
    : { narrow: false, eager: false };
  const result = await session.commit(options);
  return { certified: result.kind === "certified", reads };
}

/** The relations ScalarEvolution shows among the values a window reads, named by them. */
async function relatedReads(
  llops: Llops,
  module: string,
  point: string,
  reads: string[],
  body: Instruction[],
): Promise<Predicate[]> {
  const typeOf = (read: string) => body.find((i) => i.value === read)?.type ?? "";
  const side = { module, point, values: reads };
  const related = await relationsAt(llops, [side], reads.map(typeOf));
  const read = (whole: string, k: string) => reads[Number(k)] ?? whole;
  const name = (text: string) => text.replace(/!(\d+)/g, read);
  return related.map((predicate) => {
    if ("insts" in predicate) return { insts: predicate.insts.map(name) };
    const side = (x: string | number) => (typeof x === "number" ? x : name(x));
    return { ...predicate, lhs: side(predicate.lhs), rhs: side(predicate.rhs) };
  });
}

/**
 * The value map that splices region `at`, from the diff's pairs, and the src
 * values both windows read, or nothing when a read has no partner.
 */
function wire(src: Instruction[], tgt: Instruction[], at: Region, pairs: Map<string, string>) {
  // The diff pairs instructions before what they read, so a tgt value's first
  // partner is its instruction's.
  const back = new Map<string, string>();
  for (const [s, t] of pairs) if (!back.has(t)) back.set(t, s);
  const valuesOf = (body: Instruction[], indices: number[]) =>
    new Set(indices.flatMap((k) => body[k]?.value ?? []));
  const [mine, theirs] = [valuesOf(src, at.src), valuesOf(tgt, at.tgt)];
  const defined = new Set(tgt.flatMap((i) => i.value ?? []));
  // Values and arguments are named with `%`; constants and functions are not.
  const named = (ref: string) => ref.startsWith("%");
  const map: Record<string, string> = {};
  const reads = new Set<string>();
  for (const k of at.src)
    for (const x of src[k]?.operands ?? []) if (named(x) && !mine.has(x)) reads.add(x);
  for (const k of at.tgt)
    for (const y of tgt[k]?.operands ?? []) {
      if (!named(y) || theirs.has(y)) continue;
      // An argument is its own partner, since both sides have the same ones.
      const x = defined.has(y) ? back.get(y) : y;
      if (!x) return undefined;
      map[x] = y;
      reads.add(x);
    }
  const later = new Set(src.flatMap((i, k) => (at.src.includes(k) ? [] : i.operands)));
  for (const s of mine) {
    const t = pairs.get(s);
    if (later.has(s) && t && theirs.has(t)) map[s] = t;
  }
  return { map, reads: [...reads] };
}

/** The text `set_body` takes: the lines after `entry:` up to the closing brace on its own line. */
export function bodyOf(module: string): string {
  const lines = module.split("\n");
  const start = lines.indexOf("entry:") + 1;
  return lines.slice(start, lines.indexOf("}", start)).join("\n");
}

/** `text` without loop IDs, which alive2 ignores and LLVM may leave on two loops at once. */
export function withoutLoopIds(text: string): string {
  return text.replace(/, !llvm\.loop ![0-9]+/g, "");
}

/**
 * The window widened back to the earliest instruction, at or after `floor`,
 * that defines a value it reads.
 */
function grown(src: Instruction[], at: Region, reads: string[], floor: number): Region | undefined {
  const first = at.src[0] ?? 0;
  const defs = reads
    .map((ref) => src.findIndex((i) => i.value === ref))
    .filter((i) => i >= floor && i < first);
  if (defs.length === 0) return undefined;
  const by = first - Math.min(...defs);
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, k) => from + k);
  return {
    src: range(first - by, at.src.at(-1) ?? first),
    tgt: range((at.tgt[0] ?? 0) - by, at.tgt.at(-1) ?? 0),
    window: true,
  };
}
