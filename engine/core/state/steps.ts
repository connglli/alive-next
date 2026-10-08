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
import type { Llops, LlopsResult } from "../drivers/llops.ts";
import type { Llrwt, LlrwtInvocation, RuleInfo } from "../drivers/llrwt.ts";
import { named, resolveRef } from "../refs.ts";
import { child, type Goal, head, type Side, type Tree, workable } from "./goals.ts";
import { sha256 } from "./hash.ts";
import type { Narrowed, NoWindow, Window } from "./narrow.ts";
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

/** How a checked step is made, and whether it should look at where it lands. */
export interface CheckStepOptions {
  /**
   * The window the edit touched, or why the caller found none. A step asks about
   * it first, on the budget a cheap question gets, and falls back to the whole
   * function when that settles nothing: the window is smaller but its inputs
   * are values the program computed, so neither question is the easier one.
   */
  narrowed?: Narrowed | NoWindow;
  /**
   * Preconditions on live-in values of the window, named as in the program the
   * step opens on (e.g. { "%1": { "noundef": true } }).
   */
  preconditions?: Record<string, Record<string, unknown>>;
  /**
   * Whether to check the whole function when the check of the window does not
   * prove the step. On by default.
   */
  whole?: boolean;
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
  /** Why no window was found, when the caller looked for one. */
  narrowing?: string;
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

/** A checked step that landed, or the reason it did not. */
export type CheckStepResult =
  | {
      kind: "certified";
      hash: Hash;
      /** In order: the step, then the discharge when the eager check proved it. */
      effects: Effect[];
      /**
       * Who checked it: alive2, or with no solver `llops reshaped` when the
       * step only reshapes control flow, and `llops respected` when it only
       * changes attributes the instructions respect.
       */
      by: "alive2" | "reshaped" | "respected";
      /** What was asked: the window the edit touched, or the whole. */
      on: "window" | "whole";
      /** alive2's answer, absent when llops answered. */
      check?: CheckResult;
      /**
       * Why the step holds without a preconditioned window: the whole was
       * asked instead, or the preconditions were refused and the plain
       * window proved.
       */
      fallback?: Fallback;
      /**
       * alive2's check of the new pair, absent when the goal has no work left
       * or llops proved it with no solver.
       */
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

type Certified = Extract<CheckStepResult, { kind: "certified" }>;

/** Whether a rewrite looks at where it lands. */
export interface RewriteStepOptions {
  /**
   * Whether to check the goal's new pair afterwards. On by default, because
   * catching a discharge early is the point of it, and off for the rewrites
   * inside a larger operation, whose intermediate states are not states the
   * agent is in.
   */
  eager?: boolean;
}

/** What rewriting one side would make, as `rewritePreview` answers it. */
export type RewritePreview =
  | {
      kind: "preview";
      program: string;
      /** Whether a rule fired. */
      changed: boolean;
      invocation: LlrwtInvocation;
    }
  | { kind: "refused"; code: string; message: string };

/** A rewrite that landed, or the reason it did not. */
export type RewriteStepResult =
  | {
      kind: "certified";
      hash: Hash;
      /** In order: the step, then the discharge when the eager check proved it. */
      effects: Effect[];
      invocation: LlrwtInvocation;
      /**
       * alive2's check of the new pair, absent when the goal has no work left
       * or llops proved it with no solver.
       */
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

/** An unfold that landed, or the reason it did not. */
export type UnfoldStepResult =
  | {
      kind: "certified";
      hash: Hash;
      /** In order: the step, then the discharge when the eager check proved it. */
      effects: Effect[];
      /**
       * alive2's check of the new pair, absent when the goal has no work left
       * or llops proved it with no solver.
       */
      eager?: CheckResult;
    }
  | {
      kind: "refused";
      code: string;
      message: string;
    };

/** What checking a goal's current pair came to. */
export interface CheckGoalResult {
  outcome: "proved" | "refuted" | "unknown";
  /** Who answered: alive2, or with no solver `llops reshaped` or `llops respected`. */
  by: "alive2" | "reshaped" | "respected";
  /** alive2's answer, absent when llops answered. */
  check?: CheckResult;
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
  private readonly looping = new Map<Hash, boolean>();

  constructor(
    private readonly store: Store,
    private readonly checker: Checker,
    private readonly timeouts: Timeouts = DEFAULT_TIMEOUTS,
    private readonly llops: Llops,
    private readonly rewriter: Llrwt,
  ) {}

  /**
   * Ask whether a goal's claim holds as it stands. A proof discharges the
   * goal. A counterexample refutes the run when the checked pair is the
   * root's original pair; anywhere else it is only a hint.
   */
  async checkGoal(
    tree: Tree,
    gid: string,
    timeoutMs?: number,
    unroll?: number,
  ): Promise<CheckGoalResult> {
    const goal = workable(tree, gid);
    const srcHash = head(goal, "src");
    const tgtHash = head(goal, "tgt");
    const pair = { src: this.store.get(srcHash), tgt: this.store.get(tgtHash) };
    const free = srcHash === tgtHash ? undefined : await this.withoutSolver(pair);
    if (free && "by" in free)
      return { outcome: "proved", by: free.by, effects: [{ effect: "proved", gid, by: free.by }] };
    // alive-tv answers a loop only for the iterations it unrolls, so a pair
    // that loops is searched for a counterexample and never proved, unless
    // its two sides are the same program.
    const loops =
      srcHash !== tgtHash && ((await this.loops(pair.src)) || (await this.loops(pair.tgt)));
    if (free && loops && unroll === undefined)
      return {
        outcome: "unknown",
        by: "alive2",
        check: unasked(
          `the pair ${free.why}, so a pair that loops is proved by splitting it at its loop header; an unroll factor only searches it for a counterexample`,
        ),
        effects: [],
      };
    const key = historyKey(srcHash, tgtHash, loops ? unroll : undefined);
    const prior = this.history.get(key);

    const askedMs = timeoutMs ?? this.timeouts.checkDefaultMs;
    const budgetMs = this.capped(askedMs);
    const options = { timeoutMs: budgetMs, ...(loops ? { unroll } : {}) };
    const check = await this.alive2(pair, options);
    const outcome = loops && check.outcome === "correct" ? "unknown" : goalOutcome(check.outcome);
    this.history.set(key, { outcome, budgetMs: check.invocation.timeoutMs, ms: check.ms });

    const result: CheckGoalResult = {
      outcome,
      by: "alive2",
      check,
      effects: loops
        ? []
        : check.outcome === "correct"
          ? [{ effect: "proved", gid, by: "alive2" }]
          : check.outcome === "incorrect" && rootPair(tree, gid, goal)
            ? [{ effect: "refuted", gid }]
            : [],
    };
    if (prior) result.prior = prior;
    if (askedMs > budgetMs) result.cappedFromMs = askedMs;
    return result;
  }

  /**
   * Replace one side of a goal with a new program, if a checker agrees that
   * the goal's claim survives: `llops reshaped` or `llops respected` when the
   * step only reshapes control flow or changes attributes, and otherwise
   * alive2, on the window the edit touched and then on the whole. On refusal
   * the head does not move and the reason comes back for the agent to work with.
   */
  async checkStep(
    tree: Tree,
    gid: string,
    side: Side,
    text: string,
    options: CheckStepOptions = {},
  ): Promise<CheckStepResult> {
    const goal = workable(tree, gid);
    const beforeText = this.store.get(head(goal, side));
    const after = await this.store.put(text);
    const afterText = this.store.get(after);

    if (afterText === beforeText) {
      // Nothing moved, so there is nothing to certify and nothing to record.
      return { kind: "refused", check: unasked("the edits leave the program as it was") };
    }
    // A step that only reshapes control flow, or only changes attributes the
    // instructions respect, needs no solver, loops or not.
    const free = await this.withoutSolver(orient(side, beforeText, afterText));
    if ("by" in free) {
      const step: Effect = { effect: "step", gid, side, to: after, how: "check", by: free.by };
      const certified: Certified = {
        kind: "certified",
        hash: after,
        effects: [step],
        by: free.by,
        on: "whole",
      };
      return this.landed(goal, side, certified, options);
    }

    const narrowed = options.narrowed && "why" in options.narrowed ? undefined : options.narrowed;

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
      local = await this.alive2(orient(side, narrowed.before, narrowed.after), {
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
        : {
            reason: "no_window",
            narrowing:
              options.narrowed && "why" in options.narrowed ? options.narrowed.why : undefined,
          };
      if (options.whole === false)
        return {
          kind: "refused",
          check:
            local ?? unasked("there is no window, and asking the whole function is turned off"),
          narrowed: local,
          fallback,
        };
      const whole = await this.alive2(orient(side, beforeText, afterText), {
        timeoutMs: this.timeouts.alive2Ms,
      });
      if (whole.outcome !== "correct") {
        return {
          kind: "refused",
          check: unsolved(whole, `the step ${free.why}`),
          narrowed: local,
          fallback,
        };
      }
      check = whole;
    }
    const on = check === local ? "window" : "whole";
    // A refused preconditioned attempt and a step the plain window certified
    // mean the facts the caller asked for were dropped, and the whole-function
    // fallback that would have said so never ran. The refusal is its own
    // fallback, so the caller can say what the step holds without.
    if (conditioned?.kind === "refused" && on === "window") {
      fallback = { reason: "preconditions_refused", conditioning: conditioned.reason };
    }

    const step: Effect = { effect: "step", gid, side, to: after, how: "check", by: "alive2" };
    if (on === "window" && narrowed) {
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
    const certified: Certified = {
      kind: "certified",
      hash: after,
      effects: [step],
      by: "alive2",
      on,
      check,
      fallback,
    };
    return this.landed(goal, side, certified, options);
  }

  /** Which llops check proves with no solver that the tgt refines the src, or why neither does. */
  private async withoutSolver(pair: {
    src: string;
    tgt: string;
  }): Promise<{ by: "reshaped" | "respected" } | { why: string }> {
    const reshaped = await this.llops.reshaped(pair.src, pair.tgt);
    if (reshaped.ok && reshaped.reshaped) return { by: "reshaped" };
    const respected = await this.llops.respected(pair.src, pair.tgt);
    if (respected.ok && respected.respected) return { by: "respected" };
    const said = (answer: LlopsResult<{ why?: string }>) =>
      answer.ok ? answer.why : answer.message;
    return {
      why: `does more than reshape control flow (${said(reshaped)}) and more than change attributes the body keeps (${said(respected)})`,
    };
  }

  /** A certified step, then the cheap check of the new pair unless that is turned off. */
  private async landed(
    goal: Goal,
    side: Side,
    certified: Certified,
    options: CheckStepOptions,
  ): Promise<Certified> {
    if (options.eager === false) return certified;
    // The pair has changed, so ask cheaply whether the goal is now discharged.
    const { hash, effects } = certified;
    const eager = await this.eagerCheck(goal, goal.id, side, hash, effects);
    return { ...certified, eager };
  }

  /**
   * The rewriter's rule table, which is what a rewrite offers.
   */
  async listRules(): Promise<RuleInfo[]> {
    return this.rewriter.listRules();
  }

  /** What the verified rewriter makes of one side of a goal, landing nothing. */
  async rewritePreview(
    tree: Tree,
    gid: string,
    side: Side,
    rules: string[],
  ): Promise<RewritePreview> {
    if (rules.length === 0) {
      return { kind: "refused", code: "no_rules", message: "no rules were named" };
    }
    const from = head(workable(tree, gid), side);
    const timeoutMs = this.timeouts.llrwtMs;
    const applied = await this.rewriter.apply(this.store.get(from), rules, { timeoutMs });
    if (!applied.ok) {
      return { kind: "refused", code: applied.code, message: applied.message };
    }
    const changed = (await this.store.hashOf(applied.module)) !== from;
    return { kind: "preview", program: applied.module, changed, invocation: applied.invocation };
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
    options: RewriteStepOptions = {},
  ): Promise<RewriteStepResult> {
    // TODO: Support tgt->src rewrites (some kind of anti-optimizations).
    if (side !== "src") {
      return {
        kind: "refused",
        code: "side_unsupported",
        message: "only the src can be rewritten, since the rules only optimize",
      };
    }
    const preview = await this.rewritePreview(tree, gid, side, rules);
    if (preview.kind === "refused") return preview;
    const { invocation } = preview;
    const goal = workable(tree, gid);
    if (!preview.changed) {
      return { kind: "unchanged", hash: head(goal, side), effects: [], invocation };
    }
    const after = await this.store.put(preview.program);

    const step: Effect = {
      effect: "step",
      gid,
      side,
      to: after,
      how: "rewrite",
      rules: [...rules],
      invocation,
    };
    const effects: Effect[] = [step];
    if (options.eager === false) {
      return { kind: "certified", hash: after, effects, invocation };
    }

    // The pair has changed, so ask cheaply whether the goal is now discharged.
    const eager = await this.eagerCheck(goal, gid, side, after, effects);

    return { kind: "certified", hash: after, effects, invocation, eager };
  }

  /**
   * Put a detached loop's body on one side: in the callee at each call of the
   * hypothesis, so one call runs two iterations, or in the outer at each call
   * of the loop, so the outer runs the first iteration. The loop stays the
   * same, so no solver is asked about the step; a replay unfolds again.
   */
  async unfold(tree: Tree, gid: string, side: Side): Promise<UnfoldStepResult> {
    const goal = workable(tree, gid);
    const hypothesis = goal.detach?.hypothesis;
    const parent = goal.parent === undefined ? undefined : tree.goals.get(goal.parent);
    if (hypothesis === undefined || parent === undefined) {
      return {
        kind: "refused",
        code: "invalid",
        message: `${gid} is not a half of a loop cut at its header, so it has no loop to unfold`,
      };
    }
    // The outer takes the loop as the cut made it, which is the loop reattach puts back.
    const callee =
      goal.role === "outer"
        ? this.store.get(child(tree, parent, "callee")[side].history[0] as Hash)
        : undefined;
    const unfolded = await this.llops.unfold(this.store.get(head(goal, side)), hypothesis, callee);
    if (!unfolded.ok) return { kind: "refused", code: unfolded.code, message: unfolded.message };
    const after = await this.store.put(unfolded.module);
    const effects: Effect[] = [{ effect: "step", gid, side, to: after, how: "unfold" }];
    const eager = await this.eagerCheck(goal, gid, side, after, effects);
    return { kind: "certified", hash: after, effects, eager };
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
  ): Promise<CheckResult | undefined> {
    const eagerSrcHash = side === "src" ? after : head(goal, "src");
    const eagerTgtHash = side === "tgt" ? after : head(goal, "tgt");
    const pair = { src: this.store.get(eagerSrcHash), tgt: this.store.get(eagerTgtHash) };
    const free = eagerSrcHash === eagerTgtHash ? undefined : await this.withoutSolver(pair);
    if (free && "by" in free) {
      effects.push({ effect: "proved", gid, by: free.by });
      return undefined;
    }
    const eagerKey = historyKey(eagerSrcHash, eagerTgtHash);
    const asked = await this.alive2(pair, { timeoutMs: this.timeouts.eagerCheckMs });
    const eager = free ? unsolved(asked, `the new pair ${free.why}`) : asked;
    this.history.set(eagerKey, {
      outcome: goalOutcome(eager.outcome),
      budgetMs: eager.invocation.timeoutMs,
      ms: eager.ms,
    });
    if (eager.outcome === "correct") effects.push({ effect: "proved", gid, by: "alive2" });
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
    const [raw, outer] = await Promise.all([
      this.llops.number(before),
      this.llops.number(narrowed.outer),
    ]);
    // A precondition names a value as the step opens on it, and the window's
    // parameters are that same program's values. Either the name is the
    // parameter's own, or the instruction that defines it is shared with the
    // outer, whose value at that index is the canonical one the parameter carries.
    for (const [ref, fact] of Object.entries(preconditions)) {
      const clean = named(ref);
      const rawIdx = raw.ok ? resolveRef(raw.body, ref) : -1;
      const outerVal = outer.ok && rawIdx >= 0 ? outer.body[rawIdx]?.value : undefined;

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
      of: `!${argIdxStr}`,
    }));
    const res = await this.llops.assume(
      narrowed.outer,
      { at: "before_calls", fn: narrowed.callee },
      assertions,
    );
    if (!res.ok)
      return {
        kind: "refused",
        reason: `a precondition cannot be assumed before the window: ${res.message}`,
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
      return { kind: "refused", reason: `the window cannot be put back: ${inlined.message}` };

    const assumeCheck = await this.alive2(
      { src: whole, tgt: inlined.module },
      { timeoutMs: this.timeouts.alive2Ms },
    );
    if (assumeCheck.outcome !== "correct")
      return {
        kind: "refused",
        reason: "the preconditions are not shown to hold before the window",
      };

    // Phase 2: Add attributes to both window halves and check small pair
    let condBefore = narrowed.before;
    let condAfter = narrowed.after;
    for (const [argIdxStr, fact] of Object.entries(mappedFacts)) {
      const argIdx = Number(argIdxStr);
      const [resFrom, resTo] = await Promise.all([
        this.llops.attrs(condBefore, narrowed.callee, fact, argIdx),
        this.llops.attrs(condAfter, narrowed.callee, fact, argIdx),
      ]);
      if (!resFrom.ok || !resTo.ok)
        return {
          kind: "refused",
          reason: "a precondition cannot be put on the window's parameter",
        };
      condBefore = resFrom.module;
      condAfter = resTo.module;
    }

    const condCheck = await this.alive2(orient(side, condBefore, condAfter), {
      timeoutMs: this.timeouts.eagerCheckMs,
    });

    return { kind: "checked", check: condCheck, preconditions: mappedFacts };
  }

  /**
   * One question to alive2, in the direction the side settled. A program
   * that loops is asked about only with an unroll factor, which is a search:
   * no step or refinement is certified on one.
   */
  private async alive2(
    pair: { src: string; tgt: string },
    options: { timeoutMs: number; unroll?: number },
  ): Promise<CheckResult> {
    // A program refines itself, so the same program on both sides needs no
    // solver, and whether it loops does not matter.
    if (pair.src === pair.tgt) return unasked("the two sides are the same program", "correct");
    const cyclic = (await this.loops(pair.src)) || (await this.loops(pair.tgt));
    if (cyclic && options.unroll === undefined) return unasked(LOOPS);
    // The no-`undef` model: every query is asked with `--disable-undef-input`.
    const unroll =
      options.unroll === undefined
        ? []
        : [`--src-unroll=${options.unroll}`, `--tgt-unroll=${options.unroll}`];
    return this.checker.check(pair.src, pair.tgt, {
      timeoutMs: options.timeoutMs,
      flags: ["--disable-undef-input", ...unroll],
    });
  }

  /** Whether a program loops, as `llops validate` says. */
  private async loops(module: string): Promise<boolean> {
    const hash = sha256(module);
    const known = this.looping.get(hash);
    if (known !== undefined) return known;
    const result = await this.llops.validate(module);
    const loops = result.ok && result.cyclic;
    this.looping.set(hash, loops);
    return loops;
  }

  /**
   * Check whether tgt refines src under the no-undef model.
   *
   * Unlike checkStep(), the direction is explicit (pair.src => pair.tgt) and the
   * query is side-effect-free, leaving the goal tree and trajectory untouched.
   */
  async refinementCheck(
    src: string,
    tgt: string,
    timeoutMs: number = this.timeouts.alive2Ms,
  ): Promise<CheckResult> {
    return this.alive2({ src, tgt }, { timeoutMs: this.capped(timeoutMs) });
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
 * Whether the checked pair is the root's original pair, which is what the run
 * was asked about. A step on either side replaces it with a pair the search
 * produced.
 */
function rootPair(tree: Tree, gid: string, goal: Goal): boolean {
  return (
    gid === tree.root &&
    head(goal, "src") === goal.src.history[0] &&
    head(goal, "tgt") === goal.tgt.history[0]
  );
}

const LOOPS =
  "alive2 checks a program that loops only through a window, or for the iterations it unrolls";

/** A loop's unasked check, saying why llops did not prove it either. */
function unsolved(check: CheckResult, why: string): CheckResult {
  return check.detail === LOOPS ? { ...check, detail: `${LOOPS}, and ${why}` } : check;
}

/**
 * An answer that cost no solver time, shaped like one that did. Its budget is
 * zero because none was spent, which is what tells a reader that no check ran.
 */
function unasked(detail: string, outcome: CheckOutcome = "error"): CheckResult {
  const invocation: Invocation = { binary: "", flags: [], timeoutMs: 0 };
  return { outcome, detail, invocation, stdout: "", ms: 0 };
}

function historyKey(src: Hash, tgt: Hash, unroll?: number): string {
  return unroll === undefined ? `${src}\0${tgt}` : `${src}\0${tgt}\0${unroll}`;
}
