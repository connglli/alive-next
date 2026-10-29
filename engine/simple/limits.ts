// What a search may spend, and which of its moves it may make. The evaluation
// turns the moves off one at a time to measure what each one contributes.

export interface Limits {
  /** Wall-clock time for the whole search. */
  ms: number;
  /** The budget of the first check of the root's original pair. */
  rootMs: number;
  /** Time to look for a counterexample to a root that loops, which turns up quickly. */
  counterexampleMs: number;
  /** How many times a refused window may grow. */
  growth: number;
  /** How many cuts the root and each step goal may make at least, a peel's two as one. */
  cuts: number;
  /** How many unfolds a loop cut may make to match an unrolled or peeled loop. */
  unfolds: number;
  /** Whether to step through the optimizer's own stages before the tgt. */
  stages: boolean;
  /** Whether a stage left undecided by a whole check is searched further. */
  interpose: boolean;
  /** Whether to rewrite the src at all, rather than only cut and check. */
  steps: boolean;
  /** Whether to step the src by the verified rules where they bring it closer. */
  rules: boolean;
  /** Whether a step is checked on its window rather than on the whole function. */
  windows: boolean;
  /** Whether refused windows and new cuts get preconditions, and loop cuts invariants. */
  facts: boolean;
  /** Whether a goal its cuts leave open is split by cases on a comparison it tests. */
  cases: boolean;
}

export const DEFAULT_LIMITS: Limits = {
  ms: 3_600_000,
  rootMs: 10_000,
  counterexampleMs: 500,
  growth: 1,
  cuts: 16,
  unfolds: 4,
  stages: true,
  interpose: true,
  steps: true,
  rules: true,
  windows: true,
  facts: true,
  cases: true,
};
