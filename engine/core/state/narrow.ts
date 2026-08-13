// Narrowing a step to the part of the body that changed.
//
// A step costs what the whole function costs, whatever the edit was, and that
// is the wrong price for a local rewrite: a two instruction change can be out
// of reach whole and a second's work on its own. Narrowing outlines the window
// the edit touched out of both versions, leaving one outer and two small
// functions, and the small pair is then what a checker has to be asked about.
//
// What makes that sound is not the search. The two outers coming out identical
// is what says the difference is confined to the window, and `llops inline`
// puts each side back together, so a window that is wrong is caught rather
// than believed. The search here is free to guess: a bad guess costs a couple
// of llops calls and falls back to the whole function.
//
// It guesses twice. The tight window runs from the first line the two bodies
// disagree on to the last, which is right whenever the edit kept the number of
// instructions, since then nothing after it is renumbered. The wide one runs
// from that first disagreement to the end of the body, which is what a change
// in length leaves, and is still smaller than the whole function by the prefix
// they share.
import type { Llops, Module } from "../drivers/llops.ts";
import type { Ref } from "../refs.ts";

/** The name the outlined window has in both halves. */
const CALLEE = "outlined_window";

/** A step's obligation, narrowed to the window the edit touched. */
export interface Narrowed {
  /** The outer both versions share, which is what says the rest is untouched. */
  outer: Module;
  /** The window as it was, and as the edit leaves it. */
  before: Module;
  after: Module;
  /** The name the window carries in both. */
  callee: string;
  /** Where the window sits on each side, as the references llops was given. */
  at: { before: Window; after: Window };
}

export interface Window {
  from: Ref;
  to: Ref;
}

/**
 * The window pair for a step from `before` to `after`, or nothing when the
 * two do not line up around one window and the whole function is the only
 * question there is.
 */
export async function narrow(
  llops: Llops,
  before: Module,
  after: Module,
): Promise<Narrowed | undefined> {
  // Both sides are canonicalised first, because what the two bodies have in
  // common is read line by line and a scratch program names its values
  // whatever the edits called them. Two programs that differ only in names
  // would otherwise look like two programs that differ everywhere.
  const [was, now] = await Promise.all([llops.canon(before), llops.canon(after)]);
  if (!was.ok || !now.ok) return undefined;
  const oldBody = body(was.module);
  const newBody = body(now.module);
  if (!oldBody || !newBody) return undefined;

  for (const [oldAt, newAt] of candidates(oldBody, newBody)) {
    const found = await outlineBoth(llops, was.module, now.module, oldAt, newAt);
    if (found) return found;
  }
  return undefined;
}

/**
 * The windows worth trying, tightest first. Both start where the two bodies
 * first disagree, since everything before that is shared by construction.
 */
function candidates(oldBody: string[], newBody: string[]): [Window, Window][] {
  // The terminator is the last line and cannot go into a window.
  const oldLast = oldBody.length - 2;
  const newLast = newBody.length - 2;
  if (oldLast < 0 || newLast < 0) return [];

  const shared = common(oldBody, newBody);
  const from = Math.min(shared.prefix, oldLast, newLast);
  const tail = Math.min(shared.suffix, oldLast - from, newLast - from);

  const tries: [Window, Window][] = [];
  if (tail > 0) tries.push([at(from, oldLast - tail), at(from, newLast - tail)]);
  // The wide window is what a change in the number of instructions leaves,
  // and it is worth asking only while the two still share a prefix: from the
  // first line to the last is the whole function under another name.
  if (from > 0) tries.push([at(from, oldLast), at(from, newLast)]);
  return tries;
}

function at(from: number, to: number): Window {
  // llops names an instruction by its position when nothing else can: a window
  // edge may be a store or any other instruction defining no value.
  return { from: `#${from}`, to: `#${to}` };
}

/** How much of the two bodies is shared at each end, in whole lines. */
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

/** Outline both sides at the given windows, if the two agree on an outer. */
async function outlineBoth(
  llops: Llops,
  before: Module,
  after: Module,
  oldAt: Window,
  newAt: Window,
): Promise<Narrowed | undefined> {
  const [was, now] = await Promise.all([
    llops.outlineWindow(before, oldAt.from, oldAt.to, CALLEE),
    llops.outlineWindow(after, newAt.from, newAt.to, CALLEE),
  ]);
  if (!was.ok || !now.ok) return undefined;
  const [oldOuter, newOuter] = await Promise.all([llops.canon(was.outer), llops.canon(now.outer)]);
  if (!oldOuter.ok || !newOuter.ok) return undefined;
  if (oldOuter.module !== newOuter.module) return undefined;
  return {
    outer: oldOuter.module,
    before: was.callee,
    after: now.callee,
    callee: CALLEE,
    at: { before: oldAt, after: newAt },
  };
}

/**
 * The instruction lines of a program's one body, terminator included. The
 * store holds canonical text, so this is a scan rather than a parse; a
 * program it cannot read is one this declines to narrow.
 */
function body(module: Module): string[] | undefined {
  const lines = module.split("\n");
  const entry = lines.indexOf("entry:");
  if (entry < 0) return undefined;
  const end = lines.indexOf("}", entry);
  if (end < 0) return undefined;
  const found = lines.slice(entry + 1, end).map((line) => line.trim());
  return found.length >= 2 ? found : undefined;
}
