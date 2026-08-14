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
import { type Llops, moduleLines } from "../drivers/llops.ts";
import { definedRefAt, named, resolveRef } from "../refs.ts";
import { assumptionFlags } from "./arguments.ts";
import { hasRootEntry, head, type Side, type Tree, workable } from "./goals.ts";
import type { Narrowed } from "./narrow.ts";
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
   * The window the edit touched, when the caller found one. A step asks about
   * it first, on the budget a cheap question gets, and falls back to the whole
   * function when that settles nothing: the window is smaller but its inputs
   * are values the program computed, so neither question is the easier one.
   */
  narrowed?: Narrowed;
  /**
   * Preconditions on live-in values of the window, named as in the program the
   * step opens on (e.g. { "%1": { "noundef": true } }).
   */
  preconditions?: Record<string, Record<string, unknown>>;
  /**
   * Whether to check the goal's new pair afterwards. On by default, because
   * catching a discharge early is the point of it, and off for the steps
   * inside a larger operation, whose intermediate states are not states the
   * agent is in.
   */
  eager?: boolean;
}

export interface CheckHistoryEntry {
  outcome: "proved" | "refuted" | "unknown";
  budgetMs: number;
  ms: number;
}

export type FallbackReason = "no_window" | "window_unproved";

export interface Fallback {
  reason: FallbackReason;
  /** The window's answer, when one was tried and did not settle it. */
  narrowed?: CheckResult;
}

/** A step that landed, or the reason it did not. */
export type StepResult =
  | {
      kind: "certified";
      hash: Hash;
      /** In order: the step, then the discharge when the eager check proved it. */
      effects: Effect[];
      check: CheckResult;
      /** Which question settled it: the window the edit touched, or the whole. */
      by: "window" | "whole";
      /** Why whole-function validation was used instead of a local window. */
      fallback?: Fallback;
      /** The check of the new pair, absent when the goal has no work left. */
      eager?: CheckResult;
    }
  | {
      kind: "refused";
      check: CheckResult;
      /** The window's answer, when one was tried and did not settle it. */
      narrowed?: CheckResult;
      /** Why whole-function validation was used instead of a local window. */
      fallback?: Fallback;
    };

/** What checking a goal's current pair came to. */
export interface CheckGoalResult {
  outcome: "proved" | "refuted" | "unknown";
  check: CheckResult;
  effects: Effect[];
  /**
   * The most recent check recorded for this exact (src, tgt, flags) pair before
   * this query ran, present when the pair has been checked earlier in the session.
   */
  prior?: CheckHistoryEntry;
  /**
   * The budget that was asked for, and only when the cap cut it down to a
   * smaller one; absent when the check ran on what it was asked for. A timeout
   * on the cap is a different situation from a timeout on the whole of what
   * was wanted, and the result is where a caller tells the two apart.
   */
  cappedFromMs?: number;
}

export class Steps {
  private readonly history = new Map<string, CheckHistoryEntry>();

  constructor(
    private readonly store: Store,
    private readonly checker: Checker,
    private readonly timeouts: Timeouts = DEFAULT_TIMEOUTS,
    private readonly llops?: Llops,
  ) {}

  /**
   * Ask whether a goal's claim holds as it stands. A refutation is a hint
   * rather than a verdict: a valid step can overshoot, so what it refutes may
   * be the path rather than the translation.
   */
  async checkGoal(tree: Tree, gid: string, timeoutMs?: number): Promise<CheckGoalResult> {
    const goal = workable(tree, gid);
    const srcHash = head(goal, "src");
    const tgtHash = head(goal, "tgt");
    const flags = askedUnder(tree, gid);
    const key = historyKey(srcHash, tgtHash, flags);
    const prior = this.history.get(key);

    const askedMs = timeoutMs ?? this.timeouts.checkDefaultMs;
    const budgetMs = this.capped(askedMs);
    const check = await this.checker.check(this.store.get(srcHash), this.store.get(tgtHash), {
      timeoutMs: budgetMs,
      flags,
    });
    const outcome = goalOutcome(check.outcome);
    this.history.set(key, { outcome, budgetMs, ms: check.ms });

    const result: CheckGoalResult = {
      outcome,
      check,
      // Only execution certifies a counterexample, so a refutation changes
      // nothing here; marking a goal refuted is report_cex's business.
      effects: check.outcome === "correct" ? [{ effect: "proved", gid }] : [],
    };
    if (prior) result.prior = prior;
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
    const beforeText = this.store.get(head(goal, side));
    const after = await this.store.put(text);
    const afterText = this.store.get(after);

    if (afterText === beforeText) {
      // Nothing moved, so there is nothing to certify and nothing to record.
      return { kind: "refused", check: unchanged() };
    }

    const flags = askedUnder(tree, gid);
    // The window first, on a cheap budget. Its parameters are values the
    // program computed rather than the arguments the run was given, so it is
    // asked under no assumption at all, exactly as a cut's callee is.
    const narrowed = options.narrowed;

    let local: CheckResult | undefined;
    let usedPreconditions: Record<string, Record<string, unknown>> | undefined;

    if (narrowed && options.preconditions && this.llops) {
      const condResult = await this.tryConditionedWindow(
        beforeText,
        afterText,
        narrowed,
        options.preconditions,
        side,
        flags,
      );
      if (condResult?.check.outcome === "correct") {
        local = condResult.check;
        usedPreconditions = condResult.preconditions;
      }
    }

    if (!local && narrowed) {
      local = await this.check(orient(side, narrowed.before, narrowed.after), {
        timeoutMs: this.timeouts.eagerCheckMs,
        flags: [],
      });
    }

    // Anything but a proof falls back, a refutation included: the window is
    // asked about inputs the body around it may never produce, so what it
    // refutes may be the window rather than the step. Only the whole function
    // can refuse one.
    let check = local;
    let fallback: Fallback | undefined;
    if (check?.outcome !== "correct") {
      fallback = local ? { reason: "window_unproved", narrowed: local } : { reason: "no_window" };
      const whole = await this.check(orient(side, beforeText, afterText), {
        timeoutMs: this.timeouts.alive2Ms,
        flags,
      });
      if (whole.outcome !== "correct") {
        return {
          kind: "refused",
          check: whole,
          narrowed: local,
          fallback,
        };
      }
      check = whole;
    }
    const by = check === local ? "window" : "whole";

    const step: Effect = { effect: "step", gid, side, to: after, how };
    if (by === "window" && narrowed) {
      const [outer, from, to] = await Promise.all([
        this.store.put(narrowed.outer),
        this.store.put(narrowed.before),
        this.store.put(narrowed.after),
      ]);
      step.window = {
        callee: narrowed.callee,
        outer,
        from,
        to,
        ...(usedPreconditions && Object.keys(usedPreconditions).length > 0
          ? { preconditions: usedPreconditions }
          : {}),
      };
    }
    const effects: Effect[] = [step];
    if (options.eager === false) {
      return {
        kind: "certified",
        hash: after,
        effects,
        check,
        by,
        fallback,
      };
    }

    // The pair has changed, so ask cheaply whether the goal is now discharged.
    // The pair is built here rather than read from the tree, which does not
    // know about this step until its effect is recorded.
    const eagerSrcHash = side === "src" ? after : head(goal, "src");
    const eagerTgtHash = side === "tgt" ? after : head(goal, "tgt");
    const eagerKey = historyKey(eagerSrcHash, eagerTgtHash, flags);
    const eager = await this.checker.check(
      this.store.get(eagerSrcHash),
      this.store.get(eagerTgtHash),
      { timeoutMs: this.timeouts.eagerCheckMs, flags },
    );
    this.history.set(eagerKey, {
      outcome: goalOutcome(eager.outcome),
      budgetMs: this.timeouts.eagerCheckMs,
      ms: eager.ms,
    });
    if (eager.outcome === "correct") effects.push({ effect: "proved", gid });

    return {
      kind: "certified",
      hash: after,
      effects,
      check,
      by,
      fallback,
      eager,
    };
  }

  private async tryConditionedWindow(
    before: string,
    after: string,
    narrowed: Narrowed,
    preconditions: Record<string, Record<string, unknown>>,
    side: Side,
    flags: string[],
  ): Promise<
    { check: CheckResult; preconditions: Record<string, Record<string, unknown>> } | undefined
  > {
    if (!this.llops) return undefined;

    const mappedFacts: Record<string, Record<string, unknown>> = {};
    const rawLines = moduleLines(before);
    // A precondition names a value as the step opens on it, and the window's
    // parameters are that same program's values. Either the name is the
    // parameter's own, or the line that defines it is shared with the outer,
    // whose value at that line is the canonical one the parameter carries.
    for (const [ref, fact] of Object.entries(preconditions)) {
      const clean = named(ref);
      const rawIdx = rawLines ? resolveRef(rawLines, ref) : -1;
      const outerLines = moduleLines(narrowed.outer);
      const outerVal = rawIdx >= 0 && outerLines ? definedRefAt(outerLines, rawIdx) : undefined;

      const idx = narrowed.params.findIndex((p) => p.live === clean || p.live === outerVal);
      if (idx >= 0) {
        mappedFacts[idx] = fact;
      }
    }
    // A fact that maps to nothing would certify something other than what the
    // caller asked for, and two facts collapsing onto one parameter would
    // overwrite one of them, so the attempt is refused rather than trimmed.
    if (Object.keys(mappedFacts).length !== Object.keys(preconditions).length) return undefined;

    // Phase 1: Insert assumes before call in outer and verify whole-function
    let outerAssumed = narrowed.outer;
    for (const [argIdxStr, fact] of Object.entries(mappedFacts)) {
      const argIdx = Number(argIdxStr);
      const res = await this.llops.assume(outerAssumed, {
        before_call: narrowed.callee,
        arg: argIdx,
        fact,
      });
      if (!res.ok) return undefined;
      outerAssumed = res.module;
    }

    // Phase 1: wherever the whole being replaced is defined, the facts hold at
    // the call site. Which whole that is follows the step's direction: on the
    // src side the obligation runs forward (after refines before), so the from
    // half is asked about the before whole; on the tgt side it runs backward
    // (before refines after), so the to half is asked about the after whole.
    // Asking the wrong side would either prove nothing or refuse a step whose
    // facts only have to hold where the more defined side is.
    const half = side === "src" ? narrowed.before : narrowed.after;
    const whole = side === "src" ? before : after;
    const inlined = await this.llops.inline(outerAssumed, half, narrowed.callee);
    if (!inlined.ok) return undefined;

    const assumeCheck = await this.check(
      { src: whole, tgt: inlined.module },
      {
        timeoutMs: this.timeouts.alive2Ms,
        flags,
      },
    );
    if (assumeCheck.outcome !== "correct") return undefined;

    // Phase 2: Add attributes to both window halves and check small pair
    let condBefore = narrowed.before;
    let condAfter = narrowed.after;
    for (const [argIdxStr, fact] of Object.entries(mappedFacts)) {
      const argIdx = Number(argIdxStr);
      const op = { op: "attrs" as const, fn: narrowed.callee, param: argIdx, attrs: fact };
      const [resFrom, resTo] = await Promise.all([
        this.llops.edit(condBefore, op),
        this.llops.edit(condAfter, op),
      ]);
      if (!resFrom.ok || !resTo.ok) return undefined;
      condBefore = resFrom.module;
      condAfter = resTo.module;
    }

    const condCheck = await this.check(orient(side, condBefore, condAfter), {
      timeoutMs: this.timeouts.eagerCheckMs,
      flags: [],
    });

    return { check: condCheck, preconditions: mappedFacts };
  }

  /** One question to the checker, in the direction the side settled. */
  private check(
    pair: { src: string; tgt: string },
    options: { timeoutMs: number; flags: string[] },
  ): Promise<CheckResult> {
    return this.checker.check(pair.src, pair.tgt, options);
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

function historyKey(src: Hash, tgt: Hash, flags: string[]): string {
  return `${src}\0${tgt}\0${flags.join("\0")}`;
}
