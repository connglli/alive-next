// Loop invariants by Houdini. The candidates for a loop's cut are the analyses'
// facts and these templates: noundef on each of the callee's parameters,
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

/** Strengthens loop cut `gid` with the inductive part of `facts` and the templates. */
export async function strengthenLoop(
  session: Session,
  gid: string,
  facts: StrengthenContract,
  params: OutlineParam[],
) {
  const own = templates(params);
  const predicates = [...(facts.predicates ?? []), ...(own.predicates ?? [])];
  let candidates: StrengthenContract = {
    param_attrs: { ...own.param_attrs, ...facts.param_attrs },
    predicates: [...new Map(predicates.map((p) => [JSON.stringify(p), p])).values()],
  };
  while (size(candidates) > 0) {
    const preview = await session.strengthenPreview(gid, candidates);
    if (preview.kind !== "preview") return;
    if (size(preview.holds) === size(candidates)) break;
    const lost = noundefLost(candidates, preview.holds);
    candidates = { ...preview.holds, param_attrs: { ...preview.holds.param_attrs, ...lost } };
  }
  if (size(candidates) > 0) await session.strengthen(gid, candidates);
}

/** Noundef on each parameter, and each comparison of integer ones with zero or each other. */
function templates(params: OutlineParam[]): StrengthenContract {
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
