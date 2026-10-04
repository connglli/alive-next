// Loop invariants by Houdini. The candidates for a loop's cut are the analyses'
// facts and these guesses: noundef on each of the callee's parameters,
// comparisons of each integer parameter with zero, and comparisons between two
// of its parameters of one integer type. Each round previews the strengthen and
// keeps what holds where the loop is entered and what one iteration keeps with
// the rest assumed. When a round drops nothing, what is left is inductive, and
// the strengthen proves it.
import type { OutlineParam, Predicate } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { StrengthenContract } from "../core/state/strengthen.ts";
import { noundefLost, size } from "./facts.ts";

/** The orders a candidate compares two parameters by, each asked both ways round. */
const ORDERS = ["ule", "ult", "sle", "slt"] as const;

/** The comparisons a candidate makes of one parameter with zero. */
const WITH_ZERO = ["ne", "sge"] as const;

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
