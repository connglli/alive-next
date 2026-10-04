// Turns an expression ScalarEvolution gives back into instructions, so that
// one side of a goal can compute a value the other side computes. A value at a
// leaf is read through a partner; an expression it cannot rebuild exactly,
// such as a recurrence, gives nothing.
import type { Scev } from "../core/drivers/llops.ts";

/** Instructions that compute an expression, and the reference or constant that holds it. */
export interface Built {
  insts: string[];
  result: string;
}

/** The casts an expression can hold, with LLVM's names for them. */
const CASTS = new Set(["zext", "sext", "trunc", "ptrtoint"]);

/** The extremes an expression can hold, each an intrinsic of the same name. */
const EXTREMES = new Set(["umax", "smax", "umin", "smin"]);

/** The instructions that compute `node`, reading each value through `partner`. */
export function build(
  node: Scev,
  partner: (value: string) => string | undefined,
  fresh: () => string,
): Built | undefined {
  if (node.op === "const" || node.op === "value") {
    const result = node.op === "const" ? node.value : partner(node.value ?? "");
    return result ? { insts: [], result } : undefined;
  }
  const parts = (node.operands ?? []).map((operand) => build(operand, partner, fresh));
  if (parts.some((part) => !part)) return undefined;
  const built = parts as Built[];
  const insts = built.flatMap((part) => part.insts);
  const line = (text: string) => {
    const name = fresh();
    insts.push(`${name} = ${text}`);
    return { insts, result: name };
  };
  const [first, second] = built;
  if (CASTS.has(node.op) && first)
    return line(`${node.op} ${node.operands?.[0]?.type} ${first.result} to ${node.type}`);
  if (node.op === "udiv" && first && second)
    return line(`udiv ${node.type} ${first.result}, ${second.result}`);
  const fold = (combine: (a: string, b: string) => string) =>
    built.slice(1).reduce((acc, part) => line(combine(acc.result, part.result)), {
      insts,
      result: first?.result ?? "",
    });
  if (node.type === "ptr" && node.op === "add") return pointerSum(node, built, line);
  if (node.op === "add") return fold((a, b) => `add ${node.type} ${a}, ${b}`);
  if (node.op === "mul") return fold((a, b) => `mul ${node.type} ${a}, ${b}`);
  if (EXTREMES.has(node.op)) {
    const [type, intrinsic] = [node.type, `@llvm.${node.op}.${node.type}`];
    return fold((a, b) => `call ${type} ${intrinsic}(${type} ${a}, ${type} ${b})`);
  }
  return undefined;
}

/** A pointer plus integers, as one byte offset from the pointer. */
function pointerSum(node: Scev, built: Built[], line: (text: string) => Built) {
  const at = (node.operands ?? []).findIndex((operand) => operand.type === "ptr");
  const base = built[at];
  const offsets = built.filter((_, k) => k !== at);
  const type = node.operands?.find((operand) => operand.type !== "ptr")?.type;
  if (!base || !type || offsets.length === 0) return undefined;
  let offset = offsets[0]?.result ?? "";
  for (const part of offsets.slice(1))
    offset = line(`add ${type} ${offset}, ${part.result}`).result;
  return line(`getelementptr i8, ptr ${base.result}, ${type} ${offset}`);
}
