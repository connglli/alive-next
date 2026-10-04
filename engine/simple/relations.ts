// Linear relations among the values a cut passes, as candidates to strengthen
// it with. ScalarEvolution gives each value as constants times terms: values it
// cannot see through and, in a loop, the iterations so far. A combination of
// parameters whose terms cancel is a relation that holds, such as left == n - i
// beside a counter i; a value widened to compare it with a wider one is a guess.
import type { Llops, Predicate, Scev } from "../core/drivers/llops.ts";
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
}

/** Parameter `param` as an integer of one width, read as `read`. */
interface Row extends Linear {
  param: number;
  read: Scev;
}

/** The term a loop's iterations so far stand for. */
const ITERATIONS = "iterations";

/** The relations ScalarEvolution shows among the parameters of `types` on each side. */
export async function relationsAt(llops: Llops, sides: Side[], types: string[]) {
  const found = new Map<string, Predicate>();
  for (const side of sides) {
    const facts = await llops.analyze(side.module, "scev", side.point);
    const scev = (value: string) =>
      facts.ok ? facts.facts.find((fact) => fact.value === value)?.scev : undefined;
    const rows = side.values.flatMap((value, param) => {
      const type = types[param] ?? "";
      if (!value || value === "poison" || !/^i\d+$/.test(type)) return [];
      const named = (name: string): Scev => ({ op: "value", type, value: name });
      const form = linear(scev(value) ?? named(value), side.loop);
      return [{ ...form, param, read: named(`!${param}`) }];
    });
    const predicates = [...widths(rows)].flatMap(([type, of]) => related(of, type));
    for (const predicate of predicates) found.set(JSON.stringify(predicate), predicate);
  }
  return [...found.values()];
}

/** `node` as constants times terms, with a recurrence of `loop` counting its iterations. */
function linear(node: Scev, loop?: string): Linear {
  const term = (key: string) => ({ terms: new Map([[key, 1n]]), constant: 0n });
  if (node.op === "const") return { terms: new Map(), constant: BigInt(node.value ?? 0) };
  const parts = (node.operands ?? []).map((operand) => linear(operand, loop));
  if (node.op === "add") return parts.reduce(plus, { terms: new Map(), constant: 0n });
  const [first, second] = parts;
  const constant = (part?: Linear) => part?.terms.size === 0;
  if (node.op === "mul" && parts.length === 2 && first && second && constant(first))
    return times(second, first.constant);
  const counted = node.op === "addrec" && node.loop === loop && parts.length === 2;
  if (counted && first && second && constant(second))
    return plus(first, times(term(ITERATIONS), second.constant));
  return term(node.op === "value" ? (node.value ?? "") : JSON.stringify(node));
}

/** The sum of two linear forms. */
function plus(a: Linear, b: Linear): Linear {
  const terms = new Map(a.terms);
  for (const [key, c] of b.terms) terms.set(key, (terms.get(key) ?? 0n) + c);
  return { terms, constant: a.constant + b.constant };
}

/** A linear form times a constant. */
function times(a: Linear, c: bigint): Linear {
  const terms = new Map([...a.terms].map(([key, x]) => [key, x * c] as const));
  return { terms, constant: a.constant * c };
}

/** The rows of each width, each narrower one also widened by zext and by sext. */
function widths(rows: Row[]): Map<string, Row[]> {
  const of = new Map<string, Row[]>();
  for (const row of rows) of.set(row.read.type, [...(of.get(row.read.type) ?? []), row]);
  const bits = (type: string) => Number(type.slice(1));
  for (const wide of [...of.keys()])
    for (const row of rows.filter((row) => bits(row.read.type) < bits(wide)))
      for (const op of ["zext", "sext"])
        of.get(wide)?.push({ ...row, read: { op, type: wide, operands: [row.read] } });
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
function equation(used: { row: Row; c: bigint }[], type: string): Predicate {
  const sum = { op: "add", type, operands: used.map(({ row, c }) => scaled(row.read, c)) };
  const constant = used.reduce((total, { row, c }) => total + row.constant * c, 0n);
  let n = 0;
  const fresh = () => `%rel${n++}`;
  const built = build(sum, (value) => value, fresh);
  const bound = BigInt.asIntN(Number(type.slice(1)), constant);
  const test = `${fresh()} = icmp eq ${type} ${built?.result}, ${bound}`;
  return { insts: [...(built?.insts ?? []), test] };
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
