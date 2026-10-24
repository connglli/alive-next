// Runs: the candidates a run of a goal breaks. The goal's src is run under
// llubi on a few inputs, and at each visit of a loop's header the trace shows
// the values its cut's parameters stand for. An invariant holds at every visit
// once the loop is entered with it, so a candidate some visit breaks is dropped
// before Houdini asks alive2 about it. Only runs that return count, since
// Houdini may keep a fact that a run breaks before undefined behavior.
import type { Comparison, InputArg, Llops, OutlineParam } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { StrengthenContract } from "../core/state/strengthen.ts";
import { holdsOn } from "./facts.ts";
import type { Input } from "./refute.ts";

/** How many inputs a goal's src is run on. */
const RUNS = 12;

/** How many instructions a run may take; small inputs take a few hundred. */
const STEPS = 5_000;

/** The integers the inputs combine, chosen by position. */
const VALUES = [0n, 1n, 2n, 3n, 7n, -1n];

/** The candidates no run of goal `gid` breaks at a visit of `header`, which `params` cross. */
export async function unbrokenByRuns(
  session: Session,
  llops: Llops,
  gid: string,
  header: string,
  params: OutlineParam[],
  candidates: StrengthenContract,
): Promise<StrengthenContract> {
  const shape = await llops.validate((await session.show(gid)).src.text);
  const defined = Object.entries((shape.ok && shape.functions) || {}).find(([, f]) => f.defined);
  const inputs = defined && samples(defined[1].params.map((param) => param.type));
  if (!defined || !inputs) return candidates;
  const visits: Input[][] = [];
  for (const input of inputs) {
    const ran = await session.execute(gid, "src", input, STEPS);
    if (ran.kind !== "executed" || ran.outcome !== "returned" || ran.differences.length > 0)
      continue;
    visits.push(...visitsOf(ran.trace, defined[0], header, params));
  }
  return unbroken(candidates, visits);
}

/** Each visit of block `header` in `entry`'s frame of llubi's trace, as the values of `params`. */
export function visitsOf(
  trace: string,
  entry: string,
  header: string,
  params: OutlineParam[],
): Input[][] {
  const values = new Map<string, string>();
  const visits: Input[][] = [];
  const frames: string[] = [];
  let [visiting, calling] = [false, ""];
  const visit = () => {
    visits.push(params.map(({ live, type }) => inputOf(type, values.get(live))));
    visiting = false;
  };
  for (const line of trace.split("\n").filter((line) => line.trim() !== "")) {
    const entering = line.match(/^Entering function (\S+)$/)?.[1];
    if (entering) frames.push(entering);
    if (line.startsWith("Exiting function ")) frames.pop();
    // The harness's main calls the entry, so its frame is the second.
    if (entering || line.startsWith("Exiting") || frames.length !== 2 || frames[1] !== entry)
      continue;
    const phi = line.match(/^ {4}phi \S+ (%\S+) -> (.+)$/);
    if (phi) {
      values.set(phi[1] as string, phi[2] as string);
      continue;
    }
    if (visiting) visit();
    // A call's result comes after the frame of the function it called.
    const returned = line.match(/^ -> (.+)$/)?.[1];
    if (returned && calling) values.set(calling, returned);
    calling = line.match(/^ {2}(%\S+) = call [^>]*$/)?.[1] ?? "";
    const result = line.match(/^ {2}(%\S+) = .* -> (.+)$/) ?? line.match(/^ {2}\S+ (%\S+) = (.+)$/);
    if (result) values.set(result[1] as string, result[2] as string);
    if (line.endsWith(` jump to ${header}`)) visiting = true;
  }
  if (visiting) visit();
  return visits;
}

/** `candidates` without the facts some state of `visits` breaks. */
function unbroken(candidates: StrengthenContract, visits: Input[][]): StrengthenContract {
  const predicates = (candidates.predicates ?? []).filter(
    (predicate) => "insts" in predicate || !visits.some((at) => falsified(predicate, at)),
  );
  const attrs = Object.entries(candidates.param_attrs ?? {}).flatMap(([k, facts]) => {
    const kept = Object.entries(facts).filter(
      ([name, fact]) => !visits.some((at) => broken(name, fact, at[Number(k)])),
    );
    return kept.length > 0 ? [[k, Object.fromEntries(kept)]] : [];
  });
  return { ...candidates, param_attrs: Object.fromEntries(attrs), predicates };
}

/** Whether comparison `predicate` is false at a state, or compares a poison value. */
function falsified(predicate: Comparison, at: Input[]): boolean {
  const named = [predicate.lhs, predicate.rhs].filter((x) => typeof x === "string");
  if (named.some((x) => at[Number(String(x).slice(1))]?.poison)) return true;
  return holdsOn(predicate, at) === false;
}

/** Whether a parameter's value breaks its attribute `name`: noundef by poison, range outside it. */
function broken(name: string, fact: unknown, value?: Input): boolean {
  if (name === "noundef") return value?.poison === true;
  const bits = Number(value?.type.match(/^i(\d+)$/)?.[1]);
  const range = fact as { min?: number; max?: number };
  if (name !== "range" || value?.value === undefined || !bits) return false;
  // [min, max) wraps around, as LLVM's ranges do.
  const at = (x: bigint) => BigInt.asUintN(bits, x - BigInt(range.min ?? 0));
  return at(value.value) >= at(BigInt(range.max ?? 0));
}

/** A value llubi printed as an input of type `type`, its value unknown when it is no integer. */
function inputOf(type: string, printed?: string): Input {
  if (printed === "poison") return { type, poison: true };
  if (printed === "T" || printed === "F") return { type, value: printed === "T" ? 1n : 0n };
  const integer = printed?.match(/^i\d+ (-?\d+)$/)?.[1];
  return integer === undefined ? { type } : { type, value: BigInt(integer) };
}

/** `RUNS` inputs for parameters of `types`, or none when a type has no sample. */
function samples(types: string[]): InputArg[][] | undefined {
  const inputs = Array.from({ length: RUNS }, (_, k) => types.map((type, j) => sample(type, k, j)));
  return inputs.every((input) => input.every((arg) => arg !== undefined))
    ? (inputs as InputArg[][])
    : undefined;
}

/** Input `k` of parameter `j`: an integer from `VALUES`, shifted for each parameter, or bytes. */
function sample(type: string, k: number, j: number): InputArg | undefined {
  // A string ends in its last byte, so a loop that scans one stops inside it.
  if (type === "ptr")
    return {
      kind: "bytes",
      bytes: Array.from({ length: 64 }, (_, i) => (i === 63 ? 0 : (i * 37 + k * 11 + 5) & 255)),
      align: 16,
    };
  const bits = Number(type.match(/^i(\d+)$/)?.[1]);
  if (!bits) return undefined;
  const value = VALUES[(k + j * (1 + Math.floor(k / VALUES.length))) % VALUES.length] ?? 0n;
  return { kind: "int", value: `${bits === 1 ? value & 1n : value}` };
}
