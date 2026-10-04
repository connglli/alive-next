// Loop invariants by Houdini (Flanagan and Leino, FME 2001). The candidates for
// a loop cut are noundef on each of the callee's parameters, comparisons of
// each integer parameter with zero, and comparisons between two of its
// parameters of one integer type. Each round previews the strengthen and keeps
// what holds where the loop is entered and what one iteration keeps with the
// rest assumed. When a round drops nothing, what is left is inductive, and the
// strengthen proves it.
import type { OutlineParam, Predicate } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { StrengthenContract } from "../core/state/strengthen.ts";

/** The orders a candidate compares two parameters by, each asked both ways round. */
const ORDERS = ["ule", "ult", "sle", "slt"] as const;

/** The comparisons a candidate makes of one parameter with zero. */
const WITH_ZERO = ["ne", "sge"] as const;

/** Strengthens loop cut `gid` with the candidates about its `params` that are inductive. */
export async function strengthenLoop(session: Session, gid: string, params: OutlineParam[]) {
  let facts = candidates(params);
  while (size(facts) > 0) {
    const preview = await session.strengthenPreview(gid, facts);
    if (preview.kind !== "preview") return;
    if (size(preview.holds) === size(facts)) break;
    facts = preview.holds;
  }
  if (size(facts) > 0) await session.strengthen(gid, facts);
}

/** Noundef on each parameter, and each comparison of integer ones with zero or each other. */
function candidates(params: OutlineParam[]): StrengthenContract {
  const predicates: Predicate[] = [];
  params.forEach((a, i) => {
    if (!integer(a)) return;
    for (const op of WITH_ZERO) predicates.push({ op, lhs: `!${i}`, rhs: 0 });
    params.forEach((b, j) => {
      if (i === j || a.type !== b.type) return;
      const [lhs, rhs] = [`!${i}`, `!${j}`];
      for (const op of ORDERS) predicates.push({ op, lhs, rhs });
      if (i < j) predicates.push({ op: "eq", lhs, rhs }, { op: "ne", lhs, rhs });
    });
  });
  const noundef = Object.fromEntries(params.map((_, i) => [i, { noundef: true }]));
  return { param_attrs: noundef, predicates };
}

/** Whether a parameter is an integer, which is what a comparison takes. */
function integer(param: OutlineParam): boolean {
  return /^i\d+$/.test(param.type);
}

/** How many facts a contract states. */
function size(contract: StrengthenContract): number {
  return Object.keys(contract.param_attrs ?? {}).length + (contract.predicates ?? []).length;
}
