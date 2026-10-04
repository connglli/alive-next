// What the analyses know about the inputs of a window or a cut, as
// preconditions a commit can ask for or a cut can be strengthened with. A fact
// about a value that may be poison can never be proved at the call, so only
// values the analyses find noundef get facts.
import type { Fact, Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";

/** Facts by the value they are about, as `commit` takes them. */
export type Preconditions = Record<string, Record<string, unknown>>;

/** What the analyses know just before `point` about each of `values` that cannot be poison. */
export async function factsAt(
  llops: Llops,
  module: string,
  point: string,
  values: string[],
): Promise<Preconditions> {
  const [defined, ranges, pointers] = await Promise.all(
    (["defined", "ranges", "pointer"] as const).map((kind) => llops.analyze(module, kind, point)),
  );
  const about = (result: typeof defined, value: string) =>
    result?.ok ? result.facts.find((fact) => fact.value === value) : undefined;
  const out: Preconditions = {};
  for (const value of values) {
    if (!about(defined, value)?.noundef) continue;
    const fact: Record<string, unknown> = { noundef: true };
    const range = rangeOf(about(ranges, value));
    if (range) fact.range = range;
    const pointer = about(pointers, value);
    if (pointer?.nonnull) fact.nonnull = true;
    if ((pointer?.align ?? 1) > 1) fact.align = pointer?.align;
    if ((pointer?.dereferenceable ?? 0) > 0) fact.dereferenceable = pointer?.dereferenceable;
    out[value] = fact;
  }
  return out;
}

/**
 * Strengthens the callee of split goal `gid` with what the analyses know about
 * the values `lives` it is passed, which hold just before `point` in `src`.
 */
export async function strengthenCut(
  session: Session,
  llops: Llops,
  gid: string,
  src: string,
  point: string,
  lives: string[],
) {
  const facts = await factsAt(llops, src, point, lives);
  const attrs = lives.flatMap((live, k) => (facts[live] ? [[k, facts[live]] as const] : []));
  if (attrs.length > 0) await session.strengthen(gid, { param_attrs: Object.fromEntries(attrs) });
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
