// What a search may spend, and which of its moves it may make. The evaluation
// turns the moves off one at a time to measure what each one contributes.

export interface Limits {
  /** Wall-clock time for the whole search. */
  ms: number;
  /** The budget of the first check of the root's original pair. */
  rootMs: number;
  /** How many times a refused window may grow. */
  growth: number;
  /** How many regions may be peeled into goals of their own. */
  cuts: number;
  /** Whether to step through the optimizer's own stages before the tgt. */
  stages: boolean;
  /** Whether to rewrite the src at all, rather than only cut and check. */
  steps: boolean;
  /** Whether a step is checked on its window rather than on the whole function. */
  windows: boolean;
  /** Whether a refused window is tried again with what the analyses know. */
  facts: boolean;
}

export const DEFAULT_LIMITS: Limits = {
  ms: 3_600_000,
  rootMs: 10_000,
  growth: 1,
  cuts: 16,
  stages: true,
  steps: true,
  windows: true,
  facts: true,
};
