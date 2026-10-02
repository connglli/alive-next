// Steps a goal's src toward its tgt one region at a time. For each region,
// llops outlines it from both programs and inlines the tgt's window into the
// src's outer, which replaces only that region. The commit names the region as
// its window. When alive2 refuses, the window grows backward over the
// instructions that define the values it reads, and last, the window is tried
// again with what the analyses know about those values.
import type { Instruction, Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { factsAt } from "./facts.ts";
import { isTerminator, type Region, regions } from "./regions.ts";

/** The name both windows get, so that the tgt's one inlines where the src's one was. */
const CALLEE = "simple.region";

/**
 * Commits each region a window can hold, last to first so that no step moves
 * one still to come, and returns the regions left.
 */
export async function stepWindows(
  session: Session,
  llops: Llops,
  gid: string,
  growth: number,
): Promise<Region[]> {
  const [src, tgt] = await bodies(session, llops, gid);
  const found = regions(src, tgt);
  const across = partners(src, tgt, found);
  for (const region of [...found].reverse()) {
    const at = region.src.length && region.tgt.length ? region : widened(src, tgt, region, across);
    if (at?.window) await step(session, llops, gid, at, growth, floor(src, found, at));
  }
  return regions(...(await bodies(session, llops, gid)));
}

/** The tgt partner of each src instruction outside every region; they pair one to one, in order. */
function partners(src: Instruction[], tgt: Instruction[], found: Region[]): Map<number, number> {
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

/** The numbered bodies of a goal's two sides. */
async function bodies(
  session: Session,
  llops: Llops,
  gid: string,
): Promise<[Instruction[], Instruction[]]> {
  const view = await session.show(gid);
  const [src, tgt] = await Promise.all([llops.number(view.src.text), llops.number(view.tgt.text)]);
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
async function step(
  session: Session,
  llops: Llops,
  gid: string,
  region: Region,
  growth: number,
  floor: number,
) {
  let at: Region | undefined = region;
  for (let layer = 0; at && layer <= growth; layer++) {
    const tried = await attempt(session, llops, gid, at, false);
    if (tried.certified || !tried.reads) return tried.certified;
    const numbered = await llops.number((await session.show(gid)).src.text);
    at = numbered.ok ? grown(numbered.body, at, tried.reads, floor) : undefined;
  }
  return (await attempt(session, llops, gid, region, true)).certified;
}

/** One commit of a region's window, with facts about what it reads when asked. */
async function attempt(
  session: Session,
  llops: Llops,
  gid: string,
  at: Region,
  withFacts: boolean,
) {
  const view = await session.show(gid);
  const spliced = await splice(llops, view.src.text, view.tgt.text, at);
  if (!spliced) return { certified: false };
  const from = `#${at.src[0]}`;
  const preconditions = withFacts ? await factsAt(llops, view.src.text, from, spliced.reads) : {};
  if (withFacts && Object.keys(preconditions).length === 0)
    return { certified: false, reads: spliced.reads };
  await session.begin(gid, "src");
  const edited = await session.edit({ op: "set_body", body: bodyOf(spliced.module) });
  // The edit refuses a region that calls a function the src does not declare.
  if (edited.kind === "refused") {
    await session.abort();
    return { certified: false };
  }
  // The whole function is what windows avoid, so it is not asked, after the
  // window or after the step.
  const options = { window: { from, to: `#${at.src.at(-1)}` }, whole: false, eager: false };
  const result = await session.commit(withFacts ? { ...options, preconditions } : options);
  return { certified: result.kind === "certified", reads: spliced.reads };
}

/** The src with region `at` replaced by the tgt's code, and the values the src window reads. */
async function splice(llops: Llops, src: string, tgt: string, at: Region) {
  const [mine, theirs] = await Promise.all([
    llops.outlineWindow(src, `#${at.src[0]}`, `#${at.src.at(-1)}`, CALLEE),
    llops.outlineWindow(tgt, `#${at.tgt[0]}`, `#${at.tgt.at(-1)}`, CALLEE),
  ]);
  if (!mine.ok || !theirs.ok) return undefined;
  const back = await llops.inline(mine.outer, theirs.callee, CALLEE);
  return back.ok
    ? { module: back.module, reads: mine.params.map((param) => param.live) }
    : undefined;
}

/** The text `set_body` takes: the lines after `entry:` up to the closing brace on its own line. */
function bodyOf(module: string): string {
  const lines = module.split("\n");
  const start = lines.indexOf("entry:") + 1;
  return lines.slice(start, lines.indexOf("}", start)).join("\n");
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
