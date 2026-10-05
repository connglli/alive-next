// What the analyses know about the inputs of a window or a cut, as
// preconditions a commit can ask for or candidates to strengthen a cut with. A
// fact about a value that may be poison can never be proved at the call, so
// only values the analyses find noundef get facts.
import type {
  AnalyzeKind,
  Attrs,
  Comparison,
  Fact,
  Llops,
  Predicate,
} from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { StrengthenContract } from "../core/state/strengthen.ts";
import { type Input, inputsOf } from "./refute.ts";
import type { Side } from "./relations.ts";

/** Facts by the value they are about, as `commit` takes them. */
export type Preconditions = Record<string, Record<string, unknown>>;

/** What the analyses know just before `point` about each of `values` that cannot be poison. */
export async function factsAt(
  llops: Llops,
  module: string,
  point: string,
  values: string[],
): Promise<Preconditions> {
  const about = await analyses(llops, module, point, ["defined", "ranges", "pointer"]);
  const out: Preconditions = {};
  for (const value of values) {
    if (!about("defined", value)?.noundef) continue;
    const range = rangeOf(about("ranges", value));
    const pointer = pointerAttrs(about("pointer", value));
    out[value] = { noundef: true, ...(range ? { range } : {}), ...pointer };
  }
  return out;
}

/**
 * What the analyses know about the values a cut passes, as candidates to
 * strengthen it with. Range bounds and known bits are predicates, so each can
 * be kept on its own.
 */
export async function cutFacts(
  llops: Llops,
  module: string,
  point: string,
  lives: string[],
): Promise<StrengthenContract> {
  const about = await analyses(llops, module, point, ["defined", "ranges", "pointer", "knownbits"]);
  const param_attrs: Record<number, Attrs> = {};
  const predicates: Predicate[] = [];
  lives.forEach((live, k) => {
    if (!about("defined", live)?.noundef) return;
    param_attrs[k] = { noundef: true, ...pointerAttrs(about("pointer", live)) };
    predicates.push(...boundsOf(k, about("ranges", live)), ...knownOf(k, about("knownbits", live)));
  });
  return { param_attrs, predicates };
}

/** Each value's range bounds and known bits on `side`, as predicates, poison or not. */
export async function predicatesAt(llops: Llops, side: Side) {
  const about = await analyses(llops, side.module, side.point, ["ranges", "knownbits"]);
  return side.values.flatMap((value = "", k) => [
    ...boundsOf(k, about("ranges", value)),
    ...knownOf(k, about("knownbits", value)),
  ]);
}

/**
 * Strengthens cut `gid` with the candidates that hold: all of them at once,
 * and when that is refused, the ones a preview finds hold.
 */
export async function strengthenCut(session: Session, gid: string, candidates: StrengthenContract) {
  if (size(candidates) === 0) return;
  if ((await session.strengthen(gid, candidates)).kind === "strengthened") return;
  const holds = await holding(session, gid, candidates);
  if (size(holds) > 0 && size(holds) < size(candidates)) await session.strengthen(gid, holds);
}

/** Strengthens the cut that left `gid` with the comparisons `detail` breaks that hold. */
export async function strengthenAgainst(session: Session, gid: string, detail: string) {
  const { role, parent } = await session.show(gid);
  const predicates = violated(detail);
  if (role !== "callee" || !parent || predicates.length === 0) return false;
  const preview = await session.strengthenPreview(parent, { predicates });
  if (preview.kind !== "preview" || size(preview.holds) === 0) return false;
  return (await session.strengthen(parent, preview.holds)).kind === "strengthened";
}

/** The orders a candidate compares two parameters by, each asked both ways round. */
const ORDERS = ["ule", "ult", "sle", "slt"] as const;

/** The comparisons a candidate makes of one parameter with zero. */
const WITH_ZERO = ["ne", "sge"] as const;

/** Guesses comparisons among parameters of `types` from Houdini's templates. */
export function comparisons(types: string[]): Comparison[] {
  const out: Comparison[] = [];
  types.forEach((a, i) => {
    if (!/^i\d+$/.test(a)) return;
    // Template: An integer compared with zero, such as `key != 0`.
    for (const op of WITH_ZERO) out.push({ op, lhs: `!${i}`, rhs: 0 });
    types.forEach((b, j) => {
      if (i === j || a !== b) return;
      const [lhs, rhs] = [`!${i}`, `!${j}`];
      // Template: Two integers of one type in order, such as `j <= i`.
      for (const op of ORDERS) out.push({ op, lhs, rhs });
      // Template: Two integers of one type equal or not, each pair once.
      if (i < j) out.push({ op: "eq", lhs, rhs }, { op: "ne", lhs, rhs });
    });
  });
  return out;
}

/** The guessed comparisons that alive2's counterexample `detail` breaks. */
export function violated(detail: string): Comparison[] {
  const inputs = inputsOf(detail);
  const types = [...inputs].map((input) => input?.type ?? "");
  return comparisons(types).filter((comparison) => holdsOn(comparison, inputs) === false);
}

/** Whether `comparison` holds of `inputs`, or nothing when it reads a poison one. */
function holdsOn({ op, lhs, rhs }: Comparison, inputs: Input[]): boolean | undefined {
  const read = (x: string | number) =>
    typeof x === "number" ? BigInt(x) : inputs[Number(x.slice(1))]?.value;
  const type = inputs[Number(String(lhs).slice(1))]?.type ?? "";
  const [a, b, bits] = [read(lhs), read(rhs), Number(type.match(/^i(\d+)$/)?.[1])];
  if (a === undefined || b === undefined || !bits) return undefined;
  const fit = op.startsWith("s") ? BigInt.asIntN : BigInt.asUintN;
  const [x, y] = [fit(bits, a), fit(bits, b)];
  if (op === "eq" || op === "ne") return (x === y) === (op === "eq");
  if (op.endsWith("lt")) return x < y;
  if (op.endsWith("le")) return x <= y;
  return op.endsWith("gt") ? x > y : x >= y;
}

/** The part of `candidates` a preview finds holds, with noundef alone where attributes fail. */
async function holding(
  session: Session,
  gid: string,
  candidates: StrengthenContract,
): Promise<StrengthenContract> {
  const preview = await session.strengthenPreview(gid, candidates);
  if (preview.kind !== "preview") return {};
  const lost = noundefLost(candidates, preview.holds);
  if (Object.keys(lost).length === 0) return preview.holds;
  const again = await session.strengthenPreview(gid, { param_attrs: lost });
  const kept = again.kind === "preview" ? again.holds.param_attrs : {};
  return { ...preview.holds, param_attrs: { ...preview.holds.param_attrs, ...kept } };
}

/** Noundef alone for each parameter whose other candidate attributes `holds` drops. */
export function noundefLost(candidates: StrengthenContract, holds: StrengthenContract) {
  const kept = holds.param_attrs ?? {};
  const lost = Object.entries(candidates.param_attrs ?? {}).filter(
    ([k, attrs]) => !(k in kept) && attrs.noundef === true && Object.keys(attrs).length > 1,
  );
  return Object.fromEntries(lost.map(([k]) => [k, { noundef: true }]));
}

/** What `contracts` state, each predicate once and a later one's attributes winning. */
export function union(...contracts: StrengthenContract[]): StrengthenContract {
  const predicates = contracts.flatMap((contract) => contract.predicates ?? []);
  return {
    param_attrs: Object.assign({}, ...contracts.map((contract) => contract.param_attrs)),
    predicates: [...new Map(predicates.map((p) => [JSON.stringify(p), p])).values()],
  };
}

/** How many attributes and predicates a contract states. */
export function size(contract: StrengthenContract): number {
  const attrs = Object.values(contract.param_attrs ?? {}).flatMap((one) => Object.keys(one));
  return attrs.length + (contract.predicates ?? []).length;
}

/** What the analyses of `kinds` know just before `point`, looked up by kind and value. */
async function analyses(llops: Llops, module: string, point: string, kinds: AnalyzeKind[]) {
  const results = await Promise.all(kinds.map((kind) => llops.analyze(module, kind, point)));
  return (kind: AnalyzeKind, value: string) => {
    const result = results[kinds.indexOf(kind)];
    return result?.ok ? result.facts.find((fact) => fact.value === value) : undefined;
  };
}

/** The attributes the pointer analysis's `fact` gives its value. */
function pointerAttrs(fact?: Fact): Attrs {
  return {
    ...(fact?.nonnull ? { nonnull: true } : {}),
    ...((fact?.align ?? 1) > 1 ? { align: fact?.align } : {}),
    ...((fact?.dereferenceable ?? 0) > 0 ? { dereferenceable: fact?.dereferenceable } : {}),
  };
}

/** The bounds a range puts on parameter `k` that narrow its type, each one a comparison. */
function boundsOf(k: number, fact?: Fact): Predicate[] {
  const bits = Number(fact?.type.match(/^i(\d+)$/)?.[1]);
  if (!fact || !bits) return [];
  const top = (1n << BigInt(bits)) - 1n;
  const half = 1n << BigInt(bits - 1);
  const bounds: [Comparison["op"], string | undefined, bigint][] = [
    ["uge", fact.unsigned_min, 0n],
    ["ule", fact.unsigned_max, top],
    ["sge", fact.signed_min, -half],
    ["sle", fact.signed_max, half - 1n],
  ];
  return bounds.flatMap(([op, bound, loose]) => {
    if (bound === undefined || BigInt(bound) === loose) return [];
    const rhs = Number(bound);
    return Number.isSafeInteger(rhs) ? [{ op, lhs: `!${k}`, rhs }] : [];
  });
}

/** The bits of parameter `k` that are known, as one predicate, or none when none are. */
function knownOf(k: number, fact?: Fact): Predicate[] {
  if (!fact?.unknown_bits || !fact.one_bits || !/^i\d+$/.test(fact.type)) return [];
  const bits = BigInt(fact.type.slice(1));
  const mask = ~BigInt(fact.unknown_bits) & ((1n << bits) - 1n);
  if (mask === 0n) return [];
  const name = `%known${k}`;
  return [
    {
      insts: [
        `${name} = and ${fact.type} !${k}, ${mask}`,
        `${name}.ok = icmp eq ${fact.type} ${name}, ${BigInt(fact.one_bits)}`,
      ],
    },
  ];
}

/**
 * The narrower of a value's signed and unsigned ranges as a half-open `range`,
 * unless neither narrows or a bound is too large to send exactly.
 */
function rangeOf(fact?: Fact): { min: number; max: number } | undefined {
  const bits = Number(fact?.type.match(/^i(\d+)$/)?.[1]);
  if (!fact || !bits) return undefined;
  const pairs = [
    [fact.signed_min, fact.signed_max],
    [fact.unsigned_min, fact.unsigned_max],
  ].flatMap(([low, high]) =>
    low !== undefined && high !== undefined ? [[BigInt(low), BigInt(high)]] : [],
  );
  const narrow = pairs
    .filter(([low = 0n, high = 0n]) => high - low + 1n < 1n << BigInt(bits))
    .sort(([a = 0n, b = 0n], [c = 0n, d = 0n]) => (b - a < d - c ? -1 : b - a > d - c ? 1 : 0))[0];
  if (!narrow) return undefined;
  const [min, max] = [
    BigInt.asIntN(bits, narrow[0] ?? 0n),
    BigInt.asIntN(bits, (narrow[1] ?? 0n) + 1n),
  ];
  const exact = (x: bigint) =>
    x >= BigInt(Number.MIN_SAFE_INTEGER) && x <= BigInt(Number.MAX_SAFE_INTEGER);
  return exact(min) && exact(max) ? { min: Number(min), max: Number(max) } : undefined;
}
