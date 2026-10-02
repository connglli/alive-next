// Reading a command line: the pair it names, and the counts its flags carry.
//
// A mistake ends the process with one sentence and status 2 before a session
// exists, so a command line that names a missing file leaves nothing behind.
import { readFileSync } from "node:fs";

/** End the process, saying what was wrong. */
export function exitWithError(wrong: string): never {
  console.error(`Error: ${wrong}`);
  process.exit(2);
}

/** Run `reading`, and end the process with what it threw if it throws. */
export function tryOrExit<T>(reading: () => T): T {
  try {
    return reading();
  } catch (wrong) {
    return exitWithError(wrong instanceof Error ? wrong.message : String(wrong));
  }
}

/** The two programs the positional arguments name, and the directory after them if one is given. */
export function readPair(rest: string[]): { src: string; tgt: string; where?: string } {
  const [srcPath, tgtPath, where] = rest;
  if (!srcPath || !tgtPath) {
    const given = rest.length === 0 ? "no program" : "only one program";
    exitWithError(`${given} given, and a run proves one against another`);
  }
  return { src: readProgram(srcPath), tgt: readProgram(tgtPath), where };
}

/**
 * Read a command line's flags with `take`, which is handed each flag and a way
 * to read the value it carries. Answers the positional arguments, in order. A
 * flag `take` does not know throws rather than being read as a file, since a
 * mistyped flag would otherwise become a missing pair.
 */
export function readArgs(
  args: string[],
  take: (flag: string, value: () => string) => boolean,
): string[] {
  const rest: string[] = [];
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] as string;
    const value = (): string => {
      const next = args[++at];
      if (next === undefined) throw new Error(`${arg} wants a value`);
      return next;
    };
    if (!arg.startsWith("-")) rest.push(arg);
    else if (!take(arg, value)) throw new Error(`no such option ${arg}`);
  }
  return rest;
}

/** A count a flag carries, which is whole and above zero or it bounds nothing. */
export function readCount(flag: string, given: string): number {
  const value = Number(given);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} must be a whole number above zero, not ${given}`);
  }
  return value;
}

/** A program the command line named. */
function readProgram(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (wrong) {
    return exitWithError(`cannot read ${path}: ${(wrong as NodeJS.ErrnoException).code ?? wrong}`);
  }
}
