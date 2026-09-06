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
import type { Llrwt, LlrwtInvocation, RuleInfo } from "../drivers/llrwt.ts";
import { definedRefAt, named, resolveRef } from "../refs.ts";
import { type Goal, head, type Side, type Tree, workable } from "./goals.ts";
import type { Narrowed, Window } from "./narrow.ts";
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
  /** What one verified-rewriter run may take before it is killed. */
  llrwtMs: number;
}

export const DEFAULT_TIMEOUTS: Timeouts = {
  checkDefaultMs: 30_000,
  checkCapMs: 60_000,
  eagerCheckMs: 3_000,
  alive2Ms: 30_000,
  llrwtMs: 30_000,
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

export type FallbackReason = "no_window" | "window_unproved" | "preconditions_refused";

/**
 * Why the step was not certified by a preconditioned window. The whole
 * function is asked instead when no window was found or the window did not
 * settle it; the plain window is what certifies when the preconditions could
 * not be used, and `conditioning` says why.
 */
export interface Fallback {
  reason: FallbackReason;
  /** The window's answer, when one was tried and did not settle it. */
  narrowed?: CheckResult;
  /** The window bounds that were tried, if any. */
  window?: { before: Window; after: Window };
  /** The preconditions the reported window check actually ran under. */
  preconditions?: Record<string, Record<string, unknown>>;
  /** Why a preconditioned window attempt did not run to a check, if one was asked for. */
  conditioning?: string;
}

/**
 * A window check under preconditions, or why it never ran. The check and the
 * preconditions belong together: reporting one without the other would let a
 * fallback claim facts a check never used.
 */
type Conditioned =
  | {
      kind: "checked";
      check: CheckResult;
      preconditions: Record<string, Record<string, unknown>>;
    }
  | { kind: "refused"; reason: string };

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
      /**
       * Why the step holds without a preconditioned window: the whole was
       * asked instead, or the preconditions were refused and the plain
       * window proved.
       */
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

/** A rewrite that landed, or the reason it did not. */
export type RuleResult =
  | {
      kind: "certified";
      hash: Hash;
      /** In order: the step, then the discharge when the eager check proved it. */
      effects: Effect[];
      invocation: LlrwtInvocation;
      /** The check of the new pair, absent when the goal has no work left. */
      eager?: CheckResult;
    }
  | {
      kind: "unchanged";
      hash: Hash;
      effects: Effect[];
      invocation: LlrwtInvocation;
    }
  | {
      kind: "refused";
      code: string;
      message: string;
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
    private readonly llops: Llops,
    private readonly rewriter: Llrwt,
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
    const key = historyKey(srcHash, tgtHash);
    const prior = this.history.get(key);

    const askedMs = timeoutMs ?? this.timeouts.checkDefaultMs;
    const budgetMs = this.capped(askedMs);
    const check = await this.check(
      { src: this.store.get(srcHash), tgt: this.store.get(tgtHash) },
      { timeoutMs: budgetMs },
    );
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

    const narrowed = options.narrowed;

    let local: CheckResult | undefined;
    let usedPreconditions: Record<string, Record<string, unknown>> | undefined;
    let conditioned: Conditioned | undefined;

    if (narrowed && options.preconditions && this.llops) {
      conditioned = await this.tryConditionedWindow(
        beforeText,
        afterText,
        narrowed,
        options.preconditions,
        side,
      );
      if (conditioned?.kind === "checked") {
        if (conditioned.check.outcome === "correct") {
          local = conditioned.check;
          usedPreconditions = conditioned.preconditions;
        } else if (conditioned.check.outcome === "incorrect") {
          // The same attributes are on both window halves. Its failing input
          // satisfies them, so it also refutes the plain window query.
          local = conditioned.check;
        }
      }
    }

    if (!local && narrowed) {
      local = await this.check(orient(side, narrowed.before, narrowed.after), {
        timeoutMs: this.timeouts.eagerCheckMs,
      });
    }

    // Anything but a proof falls back, a refutation included: the window is
    // asked about inputs the body around it may never produce, so what it
    // refutes may be the window rather than the step. Only the whole function
    // can refuse one.
    let check = local;
    let fallback: Fallback | undefined;
    if (check?.outcome !== "correct") {
      fallback = local
        ? {
            reason: "window_unproved",
            // The conditioned check is the one whose preconditions the summary
            // prints, so it is the one the fallback reports when it ran; the
            // plain window check is only the fallback's evidence otherwise.
            narrowed: conditioned?.kind === "checked" ? conditioned.check : local,
            window: narrowed ? { before: narrowed.at.before, after: narrowed.at.after } : undefined,
            preconditions: conditioned?.kind === "checked" ? conditioned.preconditions : undefined,
            conditioning: conditioned?.kind === "refused" ? conditioned.reason : undefined,
          }
        : { reason: "no_window" };
      const whole = await this.check(orient(side, beforeText, afterText), {
        timeoutMs: this.timeouts.alive2Ms,
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
    // A refused preconditioned attempt and a step the plain window certified
    // mean the facts the caller asked for were dropped, and the whole-function
    // fallback that would have said so never ran. The refusal is its own
    // fallback, so the caller can say what the step holds without.
    if (conditioned?.kind === "refused" && by === "window") {
      fallback = { reason: "preconditions_refused", conditioning: conditioned.reason };
    }

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
    const eager = await this.eagerCheck(goal, gid, side, after, effects);

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

  /**
   * The rewriter's rule table, which is what a rewrite offers.
   */
  async listRules(): Promise<RuleInfo[]> {
    return this.rewriter.listRules();
  }

  /**
   * Replace one side of a goal with what the verified rewriter makes of it.
   * The rules' external proofs are what certify the move, so no alive2 run of
   * its own is needed; what is recorded is the invocation a replay reruns. An
   * unchanged answer moves nothing, and a refusal leaves the head alone with
   * the rewriter's reason to work from.
   */
  async rewrite(
    tree: Tree,
    gid: string,
    side: Side,
    rules: string[],
    options: { timeoutMs?: number; eager?: boolean } = {},
  ): Promise<RuleResult> {
    // TODO: Support tgt->src rewrites (some kind of anti-optimizations).
    if (side !== "src") {
      return {
        kind: "refused",
        code: "side_unsupported",
        message: "rewriting is supported on src only; peephole rules optimize forward",
      };
    }
    if (rules.length === 0) {
      return { kind: "refused", code: "no_rules", message: "no rules were named" };
    }
    const goal = workable(tree, gid);
    const beforeHash = head(goal, side);
    const applied = await this.rewriter.apply(this.store.get(beforeHash), rules, {
      timeoutMs: options.timeoutMs ?? this.timeouts.llrwtMs,
    });
    if (!applied.ok) return { kind: "refused", code: applied.code, message: applied.message };
    const after = await this.store.put(applied.module);
    if (after === beforeHash) {
      return { kind: "unchanged", hash: after, effects: [], invocation: applied.invocation };
    }

    const step: Effect = {
      effect: "step",
      gid,
      side,
      to: after,
      how: "rule",
      rules: [...rules],
      invocation: applied.invocation,
    };
    const effects: Effect[] = [step];
    if (options.eager === false) {
      return { kind: "certified", hash: after, effects, invocation: applied.invocation };
    }

    // The pair has changed, so ask cheaply whether the goal is now discharged.
    const eager = await this.eagerCheck(goal, gid, side, after, effects);

    return { kind: "certified", hash: after, effects, invocation: applied.invocation, eager };
  }

  /**
   * Ask cheaply whether the goal's new pair is now discharged. The pair is
   * built here rather than read from the tree, which does not know about
   * this step until its effect is recorded.
   */
  private async eagerCheck(
    goal: Goal,
    gid: string,
    side: Side,
    after: Hash,
    effects: Effect[],
  ): Promise<CheckResult> {
    const eagerSrcHash = side === "src" ? after : head(goal, "src");
    const eagerTgtHash = side === "tgt" ? after : head(goal, "tgt");
    const eagerKey = historyKey(eagerSrcHash, eagerTgtHash);
    const eager = await this.check(
      { src: this.store.get(eagerSrcHash), tgt: this.store.get(eagerTgtHash) },
      { timeoutMs: this.timeouts.eagerCheckMs },
    );
    this.history.set(eagerKey, {
      outcome: goalOutcome(eager.outcome),
      budgetMs: this.timeouts.eagerCheckMs,
      ms: eager.ms,
    });
    if (eager.outcome === "correct") effects.push({ effect: "proved", gid });
    return eager;
  }

  private async tryConditionedWindow(
    before: string,
    after: string,
    narrowed: Narrowed,
    preconditions: Record<string, Record<string, unknown>>,
    side: Side,
  ): Promise<Conditioned | undefined> {
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
    if (Object.keys(mappedFacts).length !== Object.keys(preconditions).length)
      return { kind: "refused", reason: "some preconditions do not name a value of the window" };

    // Phase 1: Insert assumes before call in outer and verify whole-function
    const assertions = Object.entries(mappedFacts).map(([argIdxStr, fact]) => ({
      fact,
      arg: Number(argIdxStr),
    }));
    const res = await this.llops.assume(
      narrowed.outer,
      { at: "before_call", fn: narrowed.callee },
      assertions,
    );
    if (!res.ok)
      return {
        kind: "refused",
        reason: `a fact could not be assumed at the call site: ${res.message}`,
      };
    const outerAssumed = res.module;

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
    if (!inlined.ok)
      return { kind: "refused", reason: `the window could not be inlined: ${inlined.message}` };

    const assumeCheck = await this.check(
      { src: whole, tgt: inlined.module },
      { timeoutMs: this.timeouts.alive2Ms },
    );
    if (assumeCheck.outcome !== "correct")
      return { kind: "refused", reason: "the facts do not hold at the call site" };

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
      if (!resFrom.ok || !resTo.ok)
        return { kind: "refused", reason: "a fact could not be attributed" };
      condBefore = resFrom.module;
      condAfter = resTo.module;
    }

    const condCheck = await this.check(orient(side, condBefore, condAfter), {
      timeoutMs: this.timeouts.eagerCheckMs,
    });

    return { kind: "checked", check: condCheck, preconditions: mappedFacts };
  }

  /** One question to the checker, in the direction the side settled. */
  private check(
    pair: { src: string; tgt: string },
    options: { timeoutMs: number },
  ): Promise<CheckResult> {
    // The no-`undef` model: every query is asked with `--disable-undef-input`.
    return this.checker.check(pair.src, pair.tgt, {
      timeoutMs: options.timeoutMs,
      flags: ["--disable-undef-input"],
    });
  }

  /**
   * Check whether tgt refines src under the no-undef model.
   *
   * Unlike step(), the direction is explicit (pair.src => pair.tgt) and the
   * query is side-effect-free, leaving the goal tree and trajectory untouched.
   */
  async refinementCheck(
    src: string,
    tgt: string,
    timeoutMs: number = this.timeouts.alive2Ms,
  ): Promise<CheckResult> {
    return this.check({ src, tgt }, { timeoutMs: this.capped(timeoutMs) });
  }

  /**
   * The cheap check of a goal's current pair, for a caller holding a tree
   * that already reflects what it did.
   */
  async eagerGoalCheck(tree: Tree, gid: string): Promise<CheckGoalResult> {
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

function historyKey(src: Hash, tgt: Hash): string {
  return `${src}\0${tgt}`;
}
