// Finds what a goal is split by cases on: the comparisons of its parameters, or
// of a parameter and an integer, that its branches test. A comparison both
// sides test comes first, since each case then drops a branch from each side,
// and a later branch before an earlier one, so that a guard at the start comes
// last.
import type { Comparison, Instruction, Llops, Predicate } from "../core/drivers/llops.ts";
import { INVERSE } from "../core/state/cases.ts";
import type { CaseOn } from "../core/state/trajectory.ts";

/** Each comparison with its operands swapped, which holds of the same values. */
const SWAPPED: Record<Comparison["op"], Comparison["op"]> = {
  eq: "eq",
  ne: "ne",
  slt: "sgt",
  sgt: "slt",
  sle: "sge",
  sge: "sle",
  ult: "ugt",
  ugt: "ult",
  ule: "uge",
  uge: "ule",
};

/** The comparisons either side's branches test that `assumed` leaves open, best first. */
export function tested(src: Instruction[], tgt: Instruction[], assumed: Predicate[] = []) {
  const [ours, theirs] = [testedBy(src), testedBy(tgt)];
  const [inSrc, inTgt] = [new Set(ours.map(keyOf)), new Set(theirs.map(keyOf))];
  const decided = new Set(assumed.flatMap((p) => ("op" in p ? [keyOf(p)] : [])));
  // Each keeps the form a branch writes it in, since `reshaped` decides no other.
  const found = new Map<string, Comparison>();
  for (const c of [...ours, ...theirs]) {
    const key = keyOf(c);
    if (!decided.has(key) && !found.has(key)) found.set(key, c);
  }
  const both = [...found].filter(([key]) => inSrc.has(key) && inTgt.has(key));
  const one = [...found].filter(([key]) => !(inSrc.has(key) && inTgt.has(key)));
  return [...both, ...one].map(([, c]) => c);
}

/** `on`, or whether a parameter it compares is poison, if `src` lets it be poison. */
export async function caseOn(llops: Llops, src: string, on: Comparison): Promise<CaseOn> {
  const result = await llops.validate(src);
  if (!result.ok) return on;
  const params = Object.values(result.functions ?? {}).find((f) => f.defined)?.params ?? [];
  const noundef = (name: string) => params[Number(name.slice(1))]?.attrs.noundef === true;
  const poison = [on.lhs, on.rhs].find((x) => typeof x === "string" && !noundef(x));
  return typeof poison === "string" ? { defined: poison } : on;
}

/** The comparisons `body`'s conditional branches test, the last branch first. */
function testedBy(body: Instruction[]): Comparison[] {
  const defined = new Map(body.flatMap((i) => (i.value ? [[i.value, i] as const] : [])));
  const branches = body.filter((i) => i.opcode === "br" && i.operands.length === 3);
  return branches.reverse().flatMap((br) => {
    const c = comparisonOf(defined.get(br.operands[0] ?? ""), defined);
    return c ? [c] : [];
  });
}

/** The comparison `i` makes, if it compares parameters, or a parameter and an integer. */
function comparisonOf(i: Instruction | undefined, defined: Map<string, Instruction>) {
  const op = i?.opcode === "icmp" ? /\bicmp (?:samesign )?(\w+) /.exec(i.text)?.[1] : "";
  if (!i || !op || !Object.hasOwn(INVERSE, op)) return undefined;
  const [lhs, rhs] = i.operands.map((x) => operandOf(x, defined));
  if (lhs === undefined || rhs === undefined) return undefined;
  if (typeof lhs === "number" && typeof rhs === "number") return undefined;
  return { op: op as Comparison["op"], lhs, rhs };
}

/** Operand `x` as a parameter, `!N` for a `%N` the body does not define, or an integer. */
function operandOf(x: string, defined: Map<string, Instruction>) {
  const param = /^%(0|[1-9]\d*)$/.exec(x)?.[1];
  if (param !== undefined && !defined.has(x)) return `!${param}`;
  return /^-?\d+$/.test(x) && Number.isSafeInteger(Number(x)) ? Number(x) : undefined;
}

/** One key for a comparison, its inverse, and each with its operands swapped. */
function keyOf({ op, lhs, rhs }: Comparison): string {
  const [o, l, r] = typeof lhs === "number" ? [SWAPPED[op], rhs, lhs] : [op, lhs, rhs];
  return `${[o, INVERSE[o]].sort()[0]} ${l} ${r}`;
}
