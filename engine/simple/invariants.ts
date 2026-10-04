// Loop invariants by Houdini. The candidates for a loop cut are noundef on each
// of the callee's parameters and the comparisons between two of its parameters
// of one integer type. Each round previews the strengthen and keeps what holds
// where the loop is entered and what one iteration keeps with the rest assumed.
// When a round drops nothing, what is left is inductive, and the strengthen
// proves it.
import type { OutlineParam, Predicate } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { StrengthenContract } from "../core/state/strengthen.ts";

/** The orders a candidate compares two parameters by, each asked both ways round. */
const ORDERS = ["ule", "ult", "sle", "slt"] as const;

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

/** Noundef on each parameter, and each comparison between two of one integer type. */
function candidates(params: OutlineParam[]): StrengthenContract {
  const predicates: Predicate[] = [];
  params.forEach((a, i) => {
    params.forEach((b, j) => {
      if (i === j || a.type !== b.type || !/^i\d+$/.test(a.type)) return;
      const [lhs, rhs] = [`!${i}`, `!${j}`];
      for (const op of ORDERS) predicates.push({ op, lhs, rhs });
      if (i < j) predicates.push({ op: "eq", lhs, rhs }, { op: "ne", lhs, rhs });
    });
  });
  const noundef = Object.fromEntries(params.map((_, i) => [i, { noundef: true }]));
  return { param_attrs: noundef, predicates };
}

/** How many facts a contract states. */
function size(contract: StrengthenContract): number {
  return Object.keys(contract.param_attrs ?? {}).length + (contract.predicates ?? []).length;
}
