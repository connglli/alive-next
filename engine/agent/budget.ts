// What a run may spend before it is stopped.
//
// A search that is getting nowhere looks exactly like one that is about to
// succeed, so the loop is bounded rather than judged. Running out is not a
// failure of the run: "unknown" is one of the three outputs, and a run that
// stopped is one a reader can pick up from its trajectory.
export interface Limits {
  /** Turns the model may take, a turn being one assistant message and its tools. */
  maxSteps?: number;
  /** Wall clock from the first turn, which is what a solver eats. */
  maxSeconds?: number;
}

export class Budget {
  private steps = 0;
  private readonly started: number;

  constructor(
    private readonly limits: Limits = {},
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
  }

  /** What has gone, for a caller that wants to say so. */
  get spent(): { steps: number; seconds: number } {
    return { steps: this.steps, seconds: Math.round((this.now() - this.started) / 1000) };
  }

  /**
   * Count one turn, and answer with why the run has to stop, or nothing while
   * it may go on.
   */
  spend(): string | undefined {
    this.steps += 1;
    const { steps, seconds } = this.spent;
    if (this.limits.maxSteps !== undefined && steps >= this.limits.maxSteps) {
      return `${steps} steps, which is the budget`;
    }
    if (this.limits.maxSeconds !== undefined && seconds >= this.limits.maxSeconds) {
      return `${seconds} seconds, which is the budget`;
    }
    return undefined;
  }
}
