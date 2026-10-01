// How a request names a value inside a function.
//
// The token that names it in printed IR, which docs/llops.md defines: `%3` for
// a slot, `%x` for a name, `#7` for the instruction at that index, which is
// the only form that reaches an instruction defining no value. llops resolves
// them, so this is a name for the string rather than a parser.
import type { Instruction } from "./drivers/llops.ts";

export type Ref = string;

/** The value a slot number or a name refers to. */
export function named(name: string): Ref {
  return name.startsWith("%") || name.startsWith("#") ? name : `%${name}`;
}

/**
 * The index of the instruction a reference names, in a body as llops lists
 * it: `#N` is its own index, and a `%name` is the instruction that defines it.
 * A number with no `%` is never a position: the programs a step opens on are
 * canonical, where every value is named, so a name that resolves to nothing is
 * a mistake worth refusing rather than a position in disguise.
 */
export function resolveRef(body: Instruction[], ref: Ref): number {
  if (ref.startsWith("#")) {
    const index = Number(ref.slice(1));
    return Number.isInteger(index) && index >= 0 && index < body.length ? index : -1;
  }
  const clean = named(ref);
  return body.findIndex((instruction) => instruction.value === clean);
}
