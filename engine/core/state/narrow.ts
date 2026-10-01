// Narrowing a step to the part of the body that changed.
//
// A step costs what the whole function costs, whatever the edit was, and that
// is the wrong price for a local rewrite: a two instruction change can be out
// of reach whole and a second's work on its own. Narrowing outlines the window
// the edit touched out of both versions, leaving one outer and two small
// functions, and the small pair is then what a checker has to be asked about.
//
// The search is not what makes that sound. Identical outers show that the
// difference is confined to the window, and `llops inline` puts each side back
// together, so a window that is wrong is caught rather than believed; the
// search puts them back too, so it proposes no window a checker would refuse.
// It is free to guess: a bad guess costs a few llops calls and falls back to
// the whole function.
//
// A window is a run of instructions in one block, the block where the two
// bodies first disagree, and it guesses twice there. The tight window runs
// from the first line they disagree on to the last in that block, which is
// right whenever the edit kept the number of instructions, since then nothing
// after it is renumbered. The wide one runs from that first disagreement to
// the end of the block, which is what a change in length leaves, and is still
// smaller than the whole function by everything it does not take.
import {
  blocksOf,
  type Instruction,
  type Llops,
  type Module,
  type OutlineParam,
} from "../drivers/llops.ts";
import { type Ref, resolveRef } from "../refs.ts";

/** The name the outlined window has in both halves. */
const CALLEE = "outlined_window";

const BLOCKS: NoWindow = { why: "the edit changes the number of blocks" };
const WHOLE: NoWindow = { why: "the window would be the whole body" };

/** A step's obligation, narrowed to the window the edit touched. */
export interface Narrowed {
  /** The outer both versions share, which shows the rest is untouched. */
  outer: Module;
  /** The window as it was, and as the edit leaves it. */
  before: Module;
  after: Module;
  /** The name the window carries in both. */
  callee: string;
  /**
   * Where the window sits on each side: the refs the caller named when it
   * named one, and the positions the search found otherwise.
   */
  at: { before: Window; after: Window };
  /** The parameters of the outlined window callee. */
  params: OutlineParam[];
}

export interface Window {
  from: Ref;
  to: Ref;
}

/** Why a step has no window, which leaves the whole function as its question. */
export interface NoWindow {
  why: string;
}

/**
 * The window pair for a step from `before` to `after`, or why not when the
 * two do not line up around one window and the whole function is the only
 * question there is.
 */
export async function narrow(
  llops: Llops,
  before: Module,
  after: Module,
): Promise<Narrowed | NoWindow> {
  // Both sides are canonicalised first, because what the two bodies have in
  // common is read line by line and a scratch program names its values
  // whatever the edits called them. Two programs that differ only in names
  // would otherwise look like two programs that differ everywhere.
  const [was, now] = await Promise.all([llops.canon(before), llops.canon(after)]);
  if (!was.ok) return { why: was.message };
  if (!now.ok) return { why: now.message };
  const [oldBody, newBody] = await Promise.all([
    llops.number(was.module),
    llops.number(now.module),
  ]);
  if (!oldBody.ok) return { why: oldBody.message };
  if (!newBody.ok) return { why: newBody.message };

  const tries = candidates(blocksOf(oldBody.body), blocksOf(newBody.body));
  if ("why" in tries) return tries;
  // The last try is the widest, so its reason is the one worth reporting.
  const reasons: NoWindow[] = [];
  for (const [oldAt, newAt] of tries) {
    const found = await outlineBoth(llops, was.module, now.module, oldAt, newAt);
    if (!("why" in found)) return found;
    reasons.push(found);
  }
  return reasons.at(-1) ?? WHOLE;
}

/** Outline the window `userWindow` names in `before`, or say why not. */
export async function narrowAt(
  llops: Llops,
  before: Module,
  after: Module,
  userWindow: Window,
): Promise<Narrowed | NoWindow> {
  const listed = await llops.number(before);
  if (!listed.ok) return { why: listed.message };
  const resolved = resolveWindow(listed.body, userWindow);
  if (!resolved)
    return { why: `${userWindow.from}..${userWindow.to} names no run of instructions` };

  const [was, now] = await Promise.all([llops.canon(before), llops.canon(after)]);
  if (!was.ok) return { why: was.message };
  if (!now.ok) return { why: now.message };
  const [oldBody, newBody] = await Promise.all([
    llops.number(was.module),
    llops.number(now.module),
  ]);
  if (!oldBody.ok) return { why: oldBody.message };
  if (!newBody.ok) return { why: newBody.message };
  const oldBlocks = blocksOf(oldBody.body);
  const newBlocks = blocksOf(newBody.body);
  if (oldBlocks.length !== newBlocks.length) return BLOCKS;

  // The window ends as far before its block's terminator on the new side as
  // it did on the old, since the edit sits inside it.
  const oldSpans = spans(oldBlocks);
  const block = oldSpans.findIndex((span) => resolved.toIdx <= span.last);
  const oldSpan = oldSpans[block];
  const newSpan = spans(newBlocks)[block];
  if (!oldSpan || !newSpan) return { why: "a window holds no terminator" };
  const newAt: Window = at(resolved.fromIdx, newSpan.last - (oldSpan.last - resolved.toIdx));

  const found = await outlineBoth(llops, was.module, now.module, resolved.window, newAt);
  if ("why" in found) return found;
  // The before bounds echo the window the caller named, which is the one it
  // will look for in a summary; the after bounds stay the mapped positions.
  return { ...found, at: { ...found.at, before: userWindow } };
}

function resolveWindow(
  body: Instruction[],
  w: Window,
): { window: Window; fromIdx: number; toIdx: number } | undefined {
  const fromIdx = resolveRef(body, w.from);
  const toIdx = resolveRef(body, w.to);
  if (fromIdx < 0 || toIdx < 0 || toIdx < fromIdx) return undefined;
  return { window: { from: `#${fromIdx}`, to: `#${toIdx}` }, fromIdx, toIdx };
}

/**
 * The windows worth trying, tightest first. Both start where the two bodies
 * first disagree, since everything before that is shared by construction, and
 * stay in the block that happens in, which is the same block on both sides.
 */
function candidates(
  oldBlocks: Instruction[][],
  newBlocks: Instruction[][],
): [Window, Window][] | NoWindow {
  if (oldBlocks.length !== newBlocks.length) return BLOCKS;
  // Phis are left out: no window holds one, and in a loop the header's phis
  // read what the body defines, so renumbering the body changes their text.
  const block = oldBlocks.findIndex(
    (block, i) => afterPhis(block).join("\n") !== afterPhis(newBlocks[i] ?? []).join("\n"),
  );
  const [oldLines, newLines] = [
    afterPhis(oldBlocks[block] ?? []),
    afterPhis(newBlocks[block] ?? []),
  ];
  const [oldSpan, newSpan] = [spans(oldBlocks)[block], spans(newBlocks)[block]];
  // The terminator is the block's last line and cannot go into a window.
  const oldLast = oldLines.length - 2;
  const newLast = newLines.length - 2;
  if (!oldSpan || !newSpan || oldLast < 0 || newLast < 0)
    return { why: "the edit changes only phis or a terminator, which no window holds" };

  const shared = common(oldLines, newLines);
  const from = Math.min(shared.prefix, oldLast, newLast);
  const tail = Math.min(shared.suffix, oldLast - from, newLast - from);
  const [oldStart, newStart] = [oldSpan.start + from, newSpan.start + from];

  const tries: [Window, Window][] = [];
  if (tail > 0) {
    tries.push([
      at(oldStart, oldSpan.start + oldLast - tail),
      at(newStart, newSpan.start + newLast - tail),
    ]);
  }
  // The wide window is what a change in the number of instructions leaves,
  // and it is worth asking only while it leaves something out: from the first
  // line of a lone block to its last is the whole function under another name.
  if (oldStart > 0 || oldBlocks.length > 1) {
    tries.push([at(oldStart, oldSpan.start + oldLast), at(newStart, newSpan.start + newLast)]);
  }
  return tries.length > 0 ? tries : WHOLE;
}

/** Each block's first index after its phis, and its last before the terminator. */
function spans(blocks: Instruction[][]): { start: number; last: number }[] {
  let start = 0;
  return blocks.map((block) => {
    const span = {
      start: start + block.filter((instruction) => instruction.phi).length,
      last: start + block.length - 2,
    };
    start += block.length;
    return span;
  });
}

/** The texts of a block's instructions after its phis. */
function afterPhis(block: Instruction[]): string[] {
  return block.filter((instruction) => !instruction.phi).map((instruction) => instruction.text);
}

function at(from: number, to: number): Window {
  // llops names an instruction by its position when nothing else can: a window
  // edge may be a store or any other instruction defining no value.
  return { from: `#${from}`, to: `#${to}` };
}

/** How much of the two bodies is shared at each end, in whole instructions. */
function common(oldBody: string[], newBody: string[]): { prefix: number; suffix: number } {
  let prefix = 0;
  while (
    prefix < oldBody.length &&
    prefix < newBody.length &&
    oldBody[prefix] === newBody[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  // Past the terminator, which both bodies have and which is not a candidate.
  while (
    suffix + prefix + 1 < oldBody.length &&
    suffix + prefix + 1 < newBody.length &&
    oldBody[oldBody.length - 2 - suffix] === newBody[newBody.length - 2 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

/** Outline both sides at the given windows, or say why not. */
async function outlineBoth(
  llops: Llops,
  before: Module,
  after: Module,
  oldAt: Window,
  newAt: Window,
): Promise<Narrowed | NoWindow> {
  const [was, now] = await Promise.all([
    llops.outlineWindow(before, oldAt.from, oldAt.to, CALLEE),
    llops.outlineWindow(after, newAt.from, newAt.to, CALLEE),
  ]);
  if (!was.ok) return { why: was.message };
  if (!now.ok) return { why: now.message };
  const [oldOuter, newOuter] = await Promise.all([llops.canon(was.outer), llops.canon(now.outer)]);
  if (!oldOuter.ok) return { why: oldOuter.message };
  if (!newOuter.ok) return { why: newOuter.message };
  if (oldOuter.module !== newOuter.module) {
    const [oldReads, newReads] = [was, now].map((half) => half.params.map((p) => p.live).join(" "));
    return {
      why:
        oldReads === newReads
          ? "the edit reaches past the window"
          : `the window reads ${oldReads} before the edit and ${newReads} after`,
    };
  }
  const back = await Promise.all([
    putBack(llops, oldOuter.module, was.callee, before),
    putBack(llops, oldOuter.module, now.callee, after),
  ]);
  if (back.includes(false)) return { why: "a half does not go back into the outer" };
  return {
    outer: oldOuter.module,
    before: was.callee,
    after: now.callee,
    callee: CALLEE,
    at: { before: oldAt, after: newAt },
    params: was.params,
  };
}

/** Whether a half inlined back into the outer is the program it came out of. */
async function putBack(llops: Llops, outer: Module, half: Module, whole: Module): Promise<boolean> {
  const back = await llops.inline(outer, half, CALLEE);
  if (!back.ok) return false;
  const same = await llops.canon(back.module);
  return same.ok && same.module === whole;
}
