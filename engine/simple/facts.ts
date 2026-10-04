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
 * be kept on its own. A loop's cut gets no pointer facts, since Houdini could
 * drop them only together with noundef.
 */
export async function cutFacts(
  llops: Llops,
  module: string,
  point: string,
  lives: string[],
  loop: boolean,
): Promise<StrengthenContract> {
  const about = await analyses(llops, module, point, ["defined", "ranges", "pointer", "knownbits"]);
  const param_attrs: Record<number, Attrs> = {};
  const predicates: Predicate[] = [];
  lives.forEach((live, k) => {
    if (!about("defined", live)?.noundef) return;
    param_attrs[k] = { noundef: true, ...(loop ? {} : pointerAttrs(about("pointer", live))) };
    predicates.push(...boundsOf(k, about("ranges", live)), ...knownOf(k, about("knownbits", live)));
  });
  return { param_attrs, predicates };
}

/**
 * Strengthens cut `gid` with the candidates that hold: all of them at once,
 * and when that is refused, the ones a preview finds hold.
 */
export async function strengthenCut(session: Session, gid: string, candidates: StrengthenContract) {
  if (size(candidates) === 0) return;
  if ((await session.strengthen(gid, candidates)).kind === "strengthened") return;
  const preview = await session.strengthenPreview(gid, candidates);
  if (preview.kind !== "preview") return;
  const holds = size(preview.holds);
  if (holds > 0 && holds < size(candidates)) await session.strengthen(gid, preview.holds);
}

/** How many facts a contract states. */
export function size(contract: StrengthenContract): number {
  return Object.keys(contract.param_attrs ?? {}).length + (contract.predicates ?? []).length;
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
