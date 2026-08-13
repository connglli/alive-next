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

/**
 * Resolves a reference to a 0-indexed instruction line number in body lines:
 * `#index` names the line, a `%name` must be defined by a line of its own. A
 * number with no `%` is never a position: the programs a step opens on are
 * canonical, where every value is named, so a name that resolves to nothing is
 * a mistake worth refusing rather than a position in disguise.
 */
export function resolveRef(bodyLines: string[], ref: Ref): number {
  if (ref.startsWith("#")) {
    const idx = parseInt(ref.slice(1), 10);
    return idx >= 0 && idx < bodyLines.length ? idx : -1;
  }
  const clean = named(ref);
  return bodyLines.findIndex((line) => {
    const match = line.match(/^([%#][\w.$]+)\s*[:=]/);
    return match ? match[1] === clean : false;
  });
}

/**
 * The reference defined at `lineIdx` in body lines (e.g. `%v1` or `%0`),
 * or undefined if that instruction defines no value (e.g. store, br, ret).
 */
export function definedRefAt(bodyLines: string[], lineIdx: number): Ref | undefined {
  if (lineIdx < 0 || lineIdx >= bodyLines.length) return undefined;
  const line = bodyLines[lineIdx];
  const match = line?.match(/^([%#][\w.$]+)\s*[:=]/);
  return match ? match[1] : undefined;
}
