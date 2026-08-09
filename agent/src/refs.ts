// How a request names a value inside a function.
//
// The token that names it in printed IR, which docs/llops.md defines: `%3` for
// a slot, `%x` for a name, `#7` for the instruction at that index, which is
// the only form that reaches an instruction defining no value. llops resolves
// them, so this is a name for the string rather than a parser.
export type Ref = string;

/** The instruction at `index`, counting from 0 at the first one in the body. */
export function atIndex(index: number): Ref {
  return `#${index}`;
}

/** The value a slot number or a name refers to. */
export function named(name: string): Ref {
  return name.startsWith("%") || name.startsWith("#") ? name : `%${name}`;
}
