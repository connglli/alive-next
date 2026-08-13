// What a run takes for granted about the arguments the pair is given.
//
// This is not something a run proves. A function's arguments come from callers
// it cannot see, so which values it may be handed is part of the question the
// run was asked rather than part of the answer. It is stated once, recorded in
// `run_start` beside the pair, and carried into every check of a goal whose
// entry is the pair's own entry.
//
// A cut's callee is not such a goal. Its parameters are values computed inside
// the program, and a program can produce undef whatever its arguments were: a
// load of uninitialised memory, an undef constant, a call to a function nobody
// has the body of. So a callee assumes nothing, and what it needs it proves at
// the call site with `tree_strengthen`.
//
// LLVM cannot say this in the IR. `noundef` on a parameter forbids poison as
// well as undef, and nothing in between exists, which is why an assumption
// that allows poison lives here and reaches alive2 as an option rather than
// being written into the programs.

export interface ArgumentAssumption {
  /** No argument is undef. */
  noUndef: boolean;
  /** No argument is poison. */
  noPoison: boolean;
}

/**
 * Defined arguments that may be poison, which is what a caller of a real
 * function can hand it: poison travels through arguments, while undef is on
 * its way out of LLVM and a question about undef-capable arguments is one
 * alive2 answers for almost nothing.
 */
export const DEFAULT_ASSUMPTION: ArgumentAssumption = { noUndef: true, noPoison: false };

/** What a run that stated nothing assumed, which is what an older log holds. */
export const NO_ASSUMPTION: ArgumentAssumption = { noUndef: false, noPoison: false };

/** The options an assumption is stated to alive-tv as. */
export function assumptionFlags(assumed: ArgumentAssumption): string[] {
  return [
    ...(assumed.noUndef ? ["--disable-undef-input"] : []),
    ...(assumed.noPoison ? ["--disable-poison-input"] : []),
  ];
}
