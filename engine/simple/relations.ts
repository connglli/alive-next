// Linear relations among the values a cut passes, as candidates to strengthen
// it with. ScalarEvolution gives each value as constants times terms: values it
// cannot see through and, in a loop, the iterations so far. A combination of
// parameters whose terms cancel is a relation that holds, such as left == n - i
// beside a counter i, and a parameter it writes as an expression over the others
// that is not linear equals that expression rebuilt; a value widened or narrowed
// to compare it with one of another width is a guess.
import type { Comparison, Llops, Predicate, Scev } from "../core/drivers/llops.ts";
import { build } from "./scev.ts";

/** One side of a cut: where it is analyzed, what each parameter is there, and its loop. */
export interface Side {
  module: string;
  point: string;
  values: (string | undefined)[];
  loop?: string;
}

/** A value as constants times terms. */
interface Linear {
  terms: Map<string, bigint>;
  constant: bigint;
  /** Whether a compound expression remains an uninterpreted term. */
  opaque: boolean;
}

/** Parameter `param` as an integer of one width, read as `read`. */
interface Row extends Linear {
  param: number;
  read: Scev;
}

/** A row in a combination, with its weight. */
type Weighted = { row: Row; c: bigint };

/** The term a loop's iterations so far stand for. */
const ITERATIONS = "iterations";

/** What ScalarEvolution gives each parameter's value on `side`, beyond the value itself. */
export async function expressionsAt(llops: Llops, side: Side) {
  const facts = await llops.analyze(side.module, "scev", side.point);
  const scev = (value?: string) =>
    facts.ok ? facts.facts.find((fact) => fact.value === value)?.scev : undefined;
  return side.values.map((value) => (value === "poison" ? undefined : scev(value)));
}

/** The relations ScalarEvolution shows among the parameters of `types` on each side. */
export async function relationsAt(llops: Llops, sides: Side[], types: string[]) {
  const found = new Map<string, Predicate>();
  for (const side of sides) {
    const trees = await expressionsAt(llops, side);
    const params = new Map(
      side.values.flatMap((value, k) =>
        value && value !== "poison" && /^i\d+$/.test(types[k] ?? "")
          ? [[value, `!${k}`] as const]
          : [],
      ),
    );
    const definitions: Predicate[] = [];
    const rows = side.values.flatMap((value, param) => {
      const type = types[param] ?? "";
      if (!value || value === "poison" || !/^i\d+$/.test(type)) return [];
      const named = (name: string): Scev => ({ op: "value", type, value: name });
      const tree = trees[param];
      const form = linear(tree ?? named(value), side.loop);
      const defined = form.opaque && tree && definition(tree, param, params);
      if (defined) definitions.push(defined);
      return [{ ...form, param, read: named(`!${param}`) }];
    });
    const predicates = [
      ...definitions,
      ...[...widths(rows)].flatMap(([type, of]) => related(of, type)),
    ];
    for (const predicate of predicates) found.set(JSON.stringify(predicate), predicate);
  }
  return [...found.values()];
}

/** A parameter defined by an expression over other parameters, when it can be rebuilt. */
function definition(tree: Scev, param: number, params: Map<string, string>): Predicate | undefined {
  let n = 0;
  const fresh = () => `%def${n++}`;
  const expression = build(tree, (value) => params.get(value), fresh);
  if (!expression?.insts.length) return undefined;
  return {
    insts: [
      ...expression.insts,
      `${fresh()} = icmp eq ${tree.type} !${param}, ${expression.result}`,
    ],
  };
}

/** `node` as constants times terms, with a recurrence of `loop` counting its iterations. */
function linear(node: Scev, loop?: string): Linear {
  const term = (key: string, opaque = false) => ({
    terms: new Map([[key, 1n]]),
    constant: 0n,
    opaque,
  });
  if (node.op === "const")
    return { terms: new Map(), constant: BigInt(node.value ?? 0), opaque: false };
  const parts = (node.operands ?? []).map((operand) => linear(operand, loop));
  if (node.op === "add")
    return parts.reduce(plus, { terms: new Map(), constant: 0n, opaque: false });
  const [first, second] = parts;
  const constant = (part?: Linear) => part?.terms.size === 0;
  if (node.op === "mul" && parts.length === 2 && first && second && constant(first))
    return times(second, first.constant);
  const counted = node.op === "addrec" && node.loop === loop && parts.length === 2;
  if (counted && first && second && constant(second))
    return plus(first, times(term(ITERATIONS), second.constant));
  return term(node.op === "value" ? (node.value ?? "") : JSON.stringify(node), node.op !== "value");
}

/** The sum of two linear forms. */
function plus(a: Linear, b: Linear): Linear {
  const terms = new Map(a.terms);
  for (const [key, c] of b.terms) terms.set(key, (terms.get(key) ?? 0n) + c);
  return { terms, constant: a.constant + b.constant, opaque: a.opaque || b.opaque };
}

/** A linear form times a constant. */
function times(a: Linear, c: bigint): Linear {
  const terms = new Map([...a.terms].map(([key, x]) => [key, x * c] as const));
  return { terms, constant: a.constant * c, opaque: a.opaque };
}

/** The rows at each integer width, using casts where their widths differ. */
function widths(rows: Row[]): Map<string, Row[]> {
  const of = new Map<string, Row[]>();
  for (const row of rows) of.set(row.read.type, [...(of.get(row.read.type) ?? []), row]);
  const bits = (type: string) => Number(type.slice(1));
  for (const type of [...of.keys()])
    for (const row of rows) {
      const [from, to] = [bits(row.read.type), bits(type)];
      const casts = from < to ? ["zext", "sext"] : from > to ? ["trunc"] : [];
      for (const op of casts)
        of.get(type)?.push({ ...row, read: { op, type, operands: [row.read] } });
    }
  return of;
}

/** Each combination of two or more parameters whose terms cancel, as a predicate. */
function related(rows: Row[], type: string): Predicate[] {
  const keys = [...new Set(rows.flatMap((row) => [...row.terms.keys()]))];
  const matrix = rows.map((row, k) => [
    ...keys.map((key) => row.terms.get(key) ?? 0n),
    ...rows.map((_, j) => (j === k ? 1n : 0n)),
  ]);
  return cancelling(matrix, keys.length).flatMap((weights) => {
    const used = rows.flatMap((row, k) => (weights[k] ? [{ row, c: weights[k] }] : []));
    if (new Set(used.map(({ row }) => row.param)).size < 2) return [];
    return [equation(used, type)];
  });
}

/** The predicate that the weighted sum of `used` is the sum of their constants. */
function equation(used: Weighted[], type: string): Predicate {
  const constant = used.reduce((total, { row, c }) => total + row.constant * c, 0n);
  const same = equality(used, constant);
  if (same) return same;
  const sum = { op: "add", type, operands: used.map(({ row, c }) => scaled(row.read, c)) };
  let n = 0;
  const fresh = () => `%rel${n++}`;
  const built = build(sum, (value) => value, fresh);
  const bound = BigInt.asIntN(Number(type.slice(1)), constant);
  const test = `${fresh()} = icmp eq ${type} ${built?.result}, ${bound}`;
  return { insts: [...(built?.insts ?? []), test] };
}

/** `used` as `!i == !j`, the form a guess states, when it says no more than that. */
function equality(used: Weighted[], constant: bigint): Comparison | undefined {
  const [a, b, ...rest] = used;
  if (!a || !b || rest.length > 0 || constant !== 0n) return undefined;
  if (a.c * a.c !== 1n || a.c + b.c !== 0n) return undefined;
  if (a.row.read.op !== "value" || b.row.read.op !== "value") return undefined;
  const [lhs, rhs] = [a.row.param, b.row.param].sort((x, y) => x - y).map((k) => `!${k}`);
  return lhs && rhs ? { op: "eq", lhs, rhs } : undefined;
}

/** `read` times `c`, as an expression. */
function scaled(read: Scev, c: bigint): Scev {
  const factor = { op: "const", type: read.type, value: `${c}` };
  return c === 1n ? read : { op: "mul", type: read.type, operands: [factor, read] };
}

/**
 * The weights of each combination of rows whose first `width` columns cancel:
 * eliminate those columns, and read the weights off the rows left at zero.
 */
function cancelling(matrix: bigint[][], width: number): bigint[][] {
  let done = 0;
  for (let col = 0; col < width; col++) {
    const at = matrix.findIndex((row, i) => i >= done && row[col] !== 0n);
    if (at < 0) continue;
    [matrix[done], matrix[at]] = [matrix[at] ?? [], matrix[done] ?? []];
    const pivot = matrix[done] ?? [];
    matrix.forEach((row, i) => {
      const [a, b] = [pivot[col] ?? 0n, row[col] ?? 0n];
      if (i !== done && b !== 0n)
        matrix[i] = reduced(row.map((x, j) => a * x - b * (pivot[j] ?? 0n)));
    });
    done++;
  }
  return matrix.slice(done).map((row) => reduced(row.slice(width)));
}

/** A row divided by the greatest common divisor of its entries. */
function reduced(row: bigint[]): bigint[] {
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const g = row.reduce((acc, x) => gcd(acc, x < 0n ? -x : x), 0n);
  return g > 1n ? row.map((x) => x / g) : row;
}
