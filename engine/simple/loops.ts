// Loops: where a goal that loops is cut, and the invariants that cut keeps. It
// is cut at its first header, or first where code outside the header's reach
// enters it, as a rotated loop's guard enters its exit. The cut's candidates
// include guessed invariants, and Houdini narrows them: each round previews the
// strengthen and keeps what holds where the loop is entered and what one
// iteration keeps with the rest assumed. When a round drops nothing, what is
// left is inductive, and the strengthen proves it.
import type { Instruction, Llops, OutlineParam, Predicate } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { SplitResult } from "../core/state/splits.ts";
import type { StrengthenContract } from "../core/state/strengthen.ts";
import { noundefLost, size } from "./facts.ts";
import { diff, headers, successors } from "./regions.ts";
import { expressionsAt, type Side } from "./relations.ts";

/** The orders a candidate compares two parameters by, each asked both ways round. */
const ORDERS = ["ule", "ult", "sle", "slt"] as const;

/** The comparisons a candidate makes of one parameter with zero. */
const WITH_ZERO = ["ne", "sge"] as const;

/** Where to cut a goal that loops, as a src block and its tgt partner. */
export function loopCut(src: Instruction[], tgt: Instruction[]) {
  const header = headers(src)[0];
  const { pairs } = diff(src, tgt);
  const at = header && entryFirst(src, header);
  const partner = at && pairs.get(at);
  if (!at || !partner) return undefined;
  // The tgt may have to be cut first where the src need not, as at a peeled loop's exit.
  const first = entryFirst(tgt, partner);
  if (first === partner) return [at, partner] as const;
  const mine = [...pairs].find(([, theirs]) => theirs === first)?.[0];
  return mine ? ([mine, first] as const) : undefined;
}

/** Unfolds loop cut `split`'s iteration on the side its counters say runs fewer. */
export async function unfoldIterations(
  session: Session,
  llops: Llops,
  split: Extract<SplitResult, { kind: "split" }>,
  sides: Side[],
) {
  const [mine = [], theirs = []] = await Promise.all(sides.map((s) => stepsAt(llops, s)));
  const ratios = mine.flatMap((step, k) => {
    const other = theirs[k];
    return step && other ? [ratio(step, other)] : [];
  });
  const [r = 0, ...rest] = new Set(ratios);
  // Each unfold doubles the iterations an iteration runs, so only a power of two matches.
  const times = rest.length > 0 ? 0 : Math.log2(Math.abs(r));
  if (!Number.isInteger(times)) return;
  const side = r > 0 ? "src" : "tgt";
  for (let n = 0; n < times; n++)
    if ((await session.unfold(split.children.callee, side)).kind !== "certified") return;
}

/** Strengthens loop cut `gid` with the inductive part of `candidates`. */
export async function strengthenLoop(
  session: Session,
  gid: string,
  candidates: StrengthenContract,
) {
  let kept = candidates;
  while (size(kept) > 0) {
    const preview = await session.strengthenPreview(gid, kept);
    if (preview.kind !== "preview") return;
    if (size(preview.holds) === size(kept)) break;
    const lost = noundefLost(kept, preview.holds);
    kept = { ...preview.holds, param_attrs: { ...preview.holds.param_attrs, ...lost } };
  }
  if (size(kept) > 0) await session.strengthen(gid, kept);
}

/** Guesses invariants about `params` from Houdini's templates. */
export function guessInvariants(params: OutlineParam[]): StrengthenContract {
  const predicates: Predicate[] = [];
  params.forEach((a, i) => {
    if (!integer(a)) return;
    // Template: An integer compared with zero, such as `key != 0`.
    for (const op of WITH_ZERO) predicates.push({ op, lhs: `!${i}`, rhs: 0 });
    params.forEach((b, j) => {
      if (i === j || a.type !== b.type) return;
      const [lhs, rhs] = [`!${i}`, `!${j}`];
      // Template: Two integers of one type in order, such as `j <= i`.
      for (const op of ORDERS) predicates.push({ op, lhs, rhs });
      // Template: Two integers of one type equal or not, each pair once.
      if (i < j) predicates.push({ op: "eq", lhs, rhs }, { op: "ne", lhs, rhs });
    });
  });
  // Template: Each parameter neither undef nor poison.
  const noundef = Object.fromEntries(params.map((_, i) => [i, { noundef: true }]));
  return { param_attrs: noundef, predicates };
}

/** Whether a parameter is an integer, which is what a comparison takes. */
function integer(param: OutlineParam): boolean {
  return /^i\d+$/.test(param.type);
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

/** Each parameter's step per iteration of `side`'s loop, where it counts them. */
async function stepsAt(llops: Llops, side: Side): Promise<(bigint | undefined)[]> {
  return (await expressionsAt(llops, side)).map((tree) => {
    const ofLoop = tree?.op === "addrec" && tree.loop === side.loop;
    const [, step, ...more] = ofLoop ? (tree?.operands ?? []) : [];
    const constant = step?.op === "const" && more.length === 0;
    return constant && step?.value ? BigInt(step.value) : undefined;
  });
}

/** How many src iterations one tgt iteration runs, as k or as -k when the reverse, or 0. */
function ratio(src: bigint, tgt: bigint): number {
  if (tgt % src === 0n && tgt / src > 0n) return Number(tgt / src);
  if (src % tgt === 0n && src / tgt > 0n) return -Number(src / tgt);
  return 0;
}
