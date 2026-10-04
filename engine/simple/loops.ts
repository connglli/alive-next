// Loops: where a goal that loops is cut, and the invariants that cut keeps. It
// is cut at its first header, or first where code outside the header's reach
// enters it, as a rotated loop's guard enters its exit. The cut's candidates
// include guessed invariants, and Houdini narrows them: each round previews the
// strengthen and keeps what holds where the loop is entered and what one
// iteration keeps with the rest assumed. When a round drops nothing, what is
// left is inductive, and the strengthen proves it.
import type { Instruction, OutlineParam, Predicate } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { StrengthenContract } from "../core/state/strengthen.ts";
import { noundefLost, size } from "./facts.ts";
import { diff } from "./regions.ts";

/** The orders a candidate compares two parameters by, each asked both ways round. */
const ORDERS = ["ule", "ult", "sle", "slt"] as const;

/** The comparisons a candidate makes of one parameter with zero. */
const WITH_ZERO = ["ne", "sge"] as const;

/** Where to cut a goal that loops, as a src block and its tgt partner. */
export function loopCut(src: Instruction[], tgt: Instruction[]) {
  const header = headers(src)[0];
  const at = header ? entryFirst(src, header) : undefined;
  const partner = at ? diff(src, tgt).pairs.get(at) : undefined;
  return at && partner ? ([at, partner] as const) : undefined;
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
