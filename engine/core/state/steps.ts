// Certified steps: the only way a goal's side ever moves.
//
// A goal claims that its tgt side refines its src side. A step replaces one
// side with a new program and has to show that the claim survives, and which
// way that check runs depends on the side. The framework owns that choice; the
// agent never states a direction.
//
// After a step lands, the goal's new pair is checked once with a small budget.
// That runs here rather than around the outside, because whether the path is
// still alive belongs in the answer the agent reads.
import type { CheckOutcome, CheckResult, Invocation } from "../drivers/alive2.ts";
import { assumptionFlags } from "./arguments.ts";
import { hasRootEntry, head, type Side, type Tree, workable } from "./goals.ts";
import type { Store } from "./store.ts";
import type { Effect, Hash } from "./trajectory.ts";

/** What this layer needs of alive-tv, so a test can stand in for it. */
export interface Checker {
  check(
    src: string,
    tgt: string,
    options?: { timeoutMs?: number; flags?: string[] },
  ): Promise<CheckResult>;
}

export interface Timeouts {
  /** What `check` uses when the agent names no timeout. */
  checkDefaultMs: number;
  /** The most the agent may ask for. */
  checkCapMs: number;
  /** The budget for the check that follows a step. */
  eagerCheckMs: number;
  /** What a commit or an apply is validated with. */
  alive2Ms: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  checkDefaultMs: 30_000,
  checkCapMs: 60_000,
  eagerCheckMs: 3_000,
  alive2Ms: 30_000,
};

/** The defaults, with whatever the configuration says on top. */
export function timeoutsFrom(config: Partial<Timeouts>): Timeouts {
  return { ...DEFAULT_TIMEOUTS, ...definedOnly(config) };
}

function definedOnly(config: Partial<Timeouts>): Partial<Timeouts> {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined),
  ) as Partial<Timeouts>;
}

/**
 * Which program plays src in the alive2 call that certifies a step.
 *
 * On the src side the step optimises forward: the new program has to refine
 * the old one, so the old one is src. On the tgt side it deoptimises backward:
 * the old program has to refine the new one, so the new one is src. Getting
 * this backwards costs a whole run and looks like a search failure, which is
 * why it is one function with a test of its own.
 */
export function orient(side: Side, before: string, after: string): { src: string; tgt: string } {
  return side === "src" ? { src: before, tgt: after } : { src: after, tgt: before };
}

/** How a step is made, and whether it should look at where it lands. */
export interface StepOptions {
  /** A rule application needs no alive2 run of its own to certify it. */
  how?: "rule" | "checked";
  /**
   * Whether to check the goal's new pair afterwards. On by default, because
   * catching a discharge early is the point of it, and off for the steps
   * inside a larger operation, whose intermediate states are not states the
   * agent is in.
   */
  eager?: boolean;
}

/** A step that landed, or the reason it did not. */
export type StepResult =
  | {
      kind: "certified";
      hash: Hash;
      /** In order: the step, then the discharge when the eager check proved it. */
      effects: Effect[];
      check: CheckResult;
      /** The check of the new pair, absent when the goal has no work left. */
      eager?: CheckResult;
    }
  | { kind: "refused"; check: CheckResult };

/** What checking a goal's current pair came to. */
export interface CheckGoalResult {
  outcome: "proved" | "refuted" | "unknown";
  check: CheckResult;
  effects: Effect[];
  /**
   * The budget that was asked for, and only when the cap cut it down to a
   * smaller one; absent when the check ran on what it was asked for. A timeout
   * on the cap is a different situation from a timeout on the whole of what
   * was wanted, and the result is where a caller tells the two apart.
   */
  cappedFromMs?: number;
}

export class Steps {
  constructor(
    private readonly store: Store,
    private readonly checker: Checker,
    private readonly timeouts: Timeouts = DEFAULT_TIMEOUTS,
  ) {}

  /**
   * Ask whether a goal's claim holds as it stands. A refutation is a hint
   * rather than a verdict: a valid step can overshoot, so what it refutes may
   * be the path rather than the translation.
   */
  async checkGoal(tree: Tree, gid: string, timeoutMs?: number): Promise<CheckGoalResult> {
    const goal = workable(tree, gid);
    const askedMs = timeoutMs ?? this.timeouts.checkDefaultMs;
    const budgetMs = this.capped(askedMs);
    const check = await this.checker.check(
      this.store.get(head(goal, "src")),
      this.store.get(head(goal, "tgt")),
      { timeoutMs: budgetMs, flags: askedUnder(tree, gid) },
    );
    const result: CheckGoalResult = {
      outcome: goalOutcome(check.outcome),
      check,
      // Only execution certifies a counterexample, so a refutation changes
      // nothing here; marking a goal refuted is report_cex's business.
      effects: check.outcome === "correct" ? [{ effect: "proved", gid }] : [],
    };
    if (askedMs > budgetMs) result.cappedFromMs = askedMs;
    return result;
  }

  /**
   * Replace one side of a goal with a new program, if alive2 agrees that the
   * goal's claim survives. On refusal the head does not move and the reason
   * comes back for the agent to work with.
   */
  async step(
    tree: Tree,
    gid: string,
    side: Side,
    text: string,
    options: StepOptions = {},
  ): Promise<StepResult> {
    const how = options.how ?? "checked";
    const goal = workable(tree, gid);
    const before = this.store.get(head(goal, side));
    const after = await this.store.put(text);
    const afterText = this.store.get(after);

    if (afterText === before) {
      // Nothing moved, so there is nothing to certify and nothing to record.
      return { kind: "refused", check: unchanged() };
    }

    const { src, tgt } = orient(side, before, afterText);
    const flags = askedUnder(tree, gid);
    const check = await this.checker.check(src, tgt, {
      timeoutMs: this.timeouts.alive2Ms,
      flags,
    });
    if (check.outcome !== "correct") return { kind: "refused", check };

    const effects: Effect[] = [{ effect: "step", gid, side, to: after, how }];
    if (options.eager === false) return { kind: "certified", hash: after, effects, check };

    // The pair has changed, so ask cheaply whether the goal is now discharged.
    // The pair is built here rather than read from the tree, which does not
    // know about this step until its effect is recorded.
    const eager = await this.checker.check(
      side === "src" ? afterText : this.store.get(head(goal, "src")),
      side === "tgt" ? afterText : this.store.get(head(goal, "tgt")),
      { timeoutMs: this.timeouts.eagerCheckMs, flags },
    );
    if (eager.outcome === "correct") effects.push({ effect: "proved", gid });

    return { kind: "certified", hash: after, effects, check, eager };
  }

  /**
   * The cheap check of a goal's current pair, for a caller holding a tree
   * that already reflects what it did.
   */
  async crossCheck(tree: Tree, gid: string): Promise<CheckGoalResult> {
    return this.checkGoal(tree, gid, this.timeouts.eagerCheckMs);
  }

  /** The budgets this run resolved to, which is what `status` reports. */
  get budgets(): Timeouts {
    return this.timeouts;
  }

  private capped(timeoutMs: number): number {
    return Math.min(timeoutMs, this.timeouts.checkCapMs);
  }
}

/**
 * What a check of this goal is asked under: the run's assumption about the
 * pair's arguments where the goal still has the pair's entry, and nothing at
 * all below a cut, where the parameters are values the program computed.
 */
function askedUnder(tree: Tree, gid: string): string[] {
  return hasRootEntry(tree, gid) ? assumptionFlags(tree.assumed) : [];
}

/** What a check's answer says about the goal it was asked about. */
function goalOutcome(outcome: CheckOutcome): CheckGoalResult["outcome"] {
  if (outcome === "correct") return "proved";
  return outcome === "incorrect" ? "refuted" : "unknown";
}

/**
 * A refusal that cost no solver time, shaped like one that did. Its budget is
 * zero because none was spent, which is what tells a reader that no check ran.
 */
function unchanged(): CheckResult {
  const invocation: Invocation = { binary: "", flags: [], timeoutMs: 0 };
  return {
    outcome: "error",
    detail: "the program is the one already there",
    invocation,
    stdout: "",
    ms: 0,
  };
}
