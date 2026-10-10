// Refutes a run with an input to the original programs, read off a
// counterexample whose inputs are the root's arguments: an unrolled check of a
// root that loops, or a refuted goal whose src is still the root's function.
// The report asks alive2 about the original pair at the input, unrolled as far
// as the check was, and only a refutation ends the run.
import type { InputArg, Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { headers } from "./regions.ts";
import { bodies } from "./windows.ts";

/** An input in alive2's example: its type, its parameter, and its bits. */
const INPUT = /^(\S+) .*?%#(\d+) = (?:#x([0-9a-f]+))?/;

/** A counterexample's input: its type, and its bits unless poison or a pointer. */
export interface Input {
  type: string;
  value?: bigint;
}

/** The inputs of alive2's counterexample `detail`, by parameter. */
export function inputsOf(detail: string): Input[] {
  const inputs: Input[] = [];
  const example = detail.match(/Example:\n([\s\S]*?)\n\n/)?.[1] ?? "";
  for (const line of example.split("\n")) {
    const [, type, k, hex] = line.match(INPUT) ?? [];
    const value = hex ? BigInt(`0x${hex}`) : undefined;
    if (type && k) inputs[Number(k)] = { type, value };
  }
  return inputs;
}

/** Unrolls a root that loops twice as far each time within `ms`, to find an input. */
export async function unrolling(session: Session, llops: Llops, root: string, ms: number) {
  const [src, tgt] = await bodies(session, llops, root);
  if (headers(src).length + headers(tgt).length === 0) return;
  for (let factor = 2, left = ms; left > 0; factor *= 2) {
    const started = Date.now();
    const { outcome, check } = await session.check(root, left, factor);
    left -= Date.now() - started;
    if (outcome === "refuted" && check) await refuteWith(session, check.detail, factor);
    if (check?.outcome !== "correct") return;
  }
}

/** Refutes the run with counterexample `detail` to `gid` when its inputs are the root's. */
export async function refuteFrom(session: Session, gid: string, detail: string) {
  const { root } = await session.status();
  for (let at = gid; at !== root; ) {
    const { role, parent } = await session.show(at);
    if (role !== "outer" || !parent) return false;
    at = parent;
  }
  return refuteWith(session, detail);
}

/** Reports the integer inputs of counterexample `detail`, unrolled `unroll` times. */
async function refuteWith(session: Session, detail: string, unroll?: number) {
  if (!detail.includes("Example:")) return false;
  const args: InputArg[] = [];
  for (const input of [...inputsOf(detail)]) {
    if (!input || !/^i\d+$/.test(input.type) || input.value === undefined) return false;
    args.push({ kind: "int", value: `0x${input.value.toString(16)}` });
  }
  return (await session.reportCex(args, unroll)).kind === "refuted";
}
