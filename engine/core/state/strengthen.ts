// Strengthening a cut's interface.
//
// Outlining cuts a large program into an outer caller and an outlined callee.
// This decomposition loses facts the caller prefix established about the live-in
// values crossing the cut boundary. As a result, an outlined callee goal may be
// unprovable on its own without interface facts the caller actually guarantees.
//
// Strengthening enriches the cut boundary with four categories of contract facts:
//
// 1. Parameter Attributes (`param_attrs`):
//    Per-argument properties on callee parameters (e.g. `noundef`, `range`,
//    `align`, `nonnull`, `dereferenceable`).
//
// 2. Predicates (`predicates`):
//    Conditions on the callee's arguments !0, !1, ...: a comparison such as
//    `{op: "ule", lhs: "!1", rhs: "!0"}`, or lines of IR ending in an i1.
//
// 3. Function Semantic Attributes (`fn_attrs`):
//    Function-level guarantees about the callee's behavior (e.g. `memory(none)`,
//    `nounwind`, `willreturn`, `nofree`).
//
// 4. Return Facts (`ret_attrs`):
//    `range`, `nonnull` or `align` on the callee's return value, which make a
//    value outside them poison.
//
// Verification proceeds in three certified phases:
//
// Phase one (caller preconditions): in `outer.src`, the parameter attributes go on
// the declaration of `@callee` and the predicates into `llvm.assume` instructions
// just before each call. Alive2 verifies this whole-program step, which refines
// the outer only if every value passed keeps each attribute and meets each
// predicate: a false predicate is undefined behavior where the original program
// was defined, and a value an attribute rules out is poison under `range`,
// `nonnull` and `align`, and undefined behavior under the others. So those three
// hold of a value that may be poison, as they do on the callee's parameter.
// `noalias` is refused, since alive2 ignores it on a declaration and on a parameter.
//
// Phase two (callee guarantees): semantic function attributes (`fn_attrs`) and
// return facts are verified on the callee's src via refinement checks
// (`unannotated => annotated`), the return facts in a strengthen of their own.
//
// Phase three (contract materialization): `outer.tgt` gains the contract phase
// one enforced on `outer.src`, so the outer's two sides stay alike, and both
// caller declarations gain the function attributes and return facts. Callee
// definitions (`callee.src` and `callee.tgt`) gain the parameter attributes,
// function attributes, entry predicates and return facts. This transition is
// recorded as an atomic `strengthen` effect linked to the justifying caller
// step (`by`), and lands with the steps before it only once every one is certified.
//
// A callee cut at a loop header also calls itself, through its hypothesis, so
// its contract is proved there too, as at the outer's calls: one iteration has
// to keep it, with the contract assumed at the callee's entry. That question is
// asked before anything lands, and its step, which declares the hypothesis
// with the parameter facts, lands right after the claim; for an iteration
// that loops, the callee goal is interposed at the program the step would make.
// The callee takes no function attribute: induction cannot prove willreturn.
// Its return facts are proved with its hypothesis returning them, which is
// induction over a contract proved without them, so they come in a strengthen
// of their own; an iteration that loops takes none, as alive2 is not asked about it.
import { availableParallelism } from "node:os";
import { type CheckResult, timedOut } from "../drivers/alive2.ts";
import type { Assertion, Attrs, Llops, Predicate } from "../drivers/llops.ts";
import {
  applyEffect,
  cased,
  child,
  type Goal,
  head,
  interposed,
  nextGoalIds,
  type Side,
  type Tree,
} from "./goals.ts";
import type { Steps } from "./steps.ts";
import type { Store } from "./store.ts";
import type { Effect, Hash, StepRef } from "./trajectory.ts";

/**
 * A full interface strengthening specification for an outlined callee.
 *
 * All fields are optional, but at least one attribute set or predicate list
 * must be provided.
 */
export interface StrengthenContract {
  /** Parameter-level attributes keyed by zero-based argument index (0, 1, ...). */
  param_attrs?: Record<number, Attrs>;
  /** Function-level attributes (e.g. memory: "none", nounwind: true, willreturn: true). */
  fn_attrs?: Attrs;
  /** Preconditions on the callee's arguments !0, !1, ...: comparisons, or lines of IR ending in an i1. */
  predicates?: Predicate[];
  /** Facts about the callee's return value: `range`, `nonnull` or `align`. */
  ret_attrs?: Attrs;
}

export type StrengthenResult =
  | { kind: "strengthened"; effects: Effect[]; checks: CheckResult[] }
  | {
      kind: "refused";
      /** Which validation phase failed, identifying why the proposal was rejected. */
      phase: "caller" | "attribute" | "callee_attr" | "hypothesis";
      reason: string;
      /** Detailed diagnostic explanation for humans and agents. */
      explanation?: string;
      /** The solver result when Alive2 refused the step. */
      check?: CheckResult;
      /** None: a strengthen lands only once every step is certified. */
      effects: Effect[];
    };

/** The part of a contract that a strengthen would prove, as `preview` answers it. */
export type StrengthenPreview =
  | { kind: "preview"; holds: StrengthenContract }
  | { kind: "refused"; reason: string };

export class Strengthen {
  constructor(
    private readonly store: Store,
    private readonly llops: Llops,
    private readonly steps: Steps,
  ) {}

  /**
   * Strengthen the interface of the outlined function of the cut at goal `gid`.
   *
   * Proves caller preconditions, certifies callee function attributes, materializes
   * the contract across caller and callee programs, and eagerly cross-checks child goals.
   */
  async strengthen(
    tree: Tree,
    gid: string,
    contract: StrengthenContract,
  ): Promise<StrengthenResult> {
    const rawParamAttrs = contract.param_attrs ?? {};
    const fnAttrs = contract.fn_attrs ?? {};
    const predicates = contract.predicates ?? [];
    const retAttrs = contract.ret_attrs ?? {};
    const params = paramsOf(rawParamAttrs);
    const hasParamAttrs = params.length > 0;
    const hasFnAttrs = Object.keys(fnAttrs).length > 0;
    const hasPredicates = predicates.length > 0;
    const hasRetAttrs = Object.keys(retAttrs).length > 0;

    if (!hasParamAttrs && !hasFnAttrs && !hasPredicates && !hasRetAttrs) {
      throw new Error(
        `there is nothing to add: give param_attrs, fn_attrs, predicates or ret_attrs`,
      );
    }

    const halves = this.halves(tree, gid);
    if ("reason" in halves)
      return { kind: "refused", phase: "caller", reason: halves.reason, effects: [] };
    const { outer, callee, name, hypothesis } = halves;
    if (hypothesis && hasFnAttrs) {
      const reason = `@${name} calls @${hypothesis}, so it takes no function attributes: induction cannot prove willreturn`;
      return { kind: "refused", phase: "callee_attr", reason, effects: [] };
    }
    if (!holdsOfPoison(retAttrs)) {
      const reason = `a return fact is range, nonnull or align, which make a value outside them poison`;
      return { kind: "refused", phase: "callee_attr", reason, effects: [] };
    }
    // A loop's contract is proved at its hypothesis's calls with nothing known
    // of what the hypothesis returns, since its return facts rest on that contract.
    if (hasRetAttrs && (hasParamAttrs || hasFnAttrs || hasPredicates)) {
      const reason = `return facts come in a strengthen of their own, after the facts they rest on`;
      return { kind: "refused", phase: "callee_attr", reason, effects: [] };
    }
    const aliasing = noaliasIn(rawParamAttrs);
    if (aliasing !== undefined) {
      const reason = `parameter ${aliasing}: alive2 ignores noalias, so it can be neither proved at a call nor assumed by the callee`;
      return { kind: "refused", phase: "caller", reason, effects: [] };
    }

    // Return facts the declaration already has add nothing to prove.
    const returned = hasRetAttrs
      ? await this.returning(this.store.get(head(outer, "src")), name, retAttrs)
      : undefined;
    if (typeof returned === "object") {
      return { kind: "refused", phase: "attribute", reason: returned.reason, effects: [] };
    }
    if (returned !== undefined && (await this.store.put(returned)) === head(outer, "src")) {
      const reason = `the declaration of @${name} already has every fact, so there is nothing to add`;
      return { kind: "refused", phase: "caller", reason, effects: [] };
    }

    // The parameters whose facts a poison argument breaks: those given an
    // attribute other than range, nonnull and align, and each `!N` in a predicate.
    const needsValue = new Set([
      ...params.filter((param) => !holdsOfPoison(rawParamAttrs[param] ?? {})),
      ...predicates.flatMap(namedIn),
    ]);
    const checks: CheckResult[] = [];
    let by: StepRef | undefined;

    // At the callee's start only its arguments are in scope, so llops refuses
    // a contract that names anything else. Ask that before anything lands.
    if (hasPredicates) {
      const start = { at: "start" as const, fn: name };
      const probe = await this.llops.assume(this.store.get(head(callee, "src")), start, predicates);
      if (!probe.ok)
        return { kind: "refused", phase: "caller", reason: probe.message, effects: [] };
    }

    // Phase 0, for a loop: the contract has to hold again where the callee
    // calls its hypothesis, with the contract assumed at its entry. That is
    // one iteration keeping it, asked before anything lands unless it loops,
    // so a contract the loop does not keep changes nothing.
    let kept: { from: Hash; hash: Hash; loops: boolean } | undefined;
    if (hypothesis && (hasParamAttrs || hasPredicates)) {
      const entered = await this.materialize(this.store.get(head(callee, "src")), name, contract);
      if (typeof entered !== "string") return { ...entered, effects: [] };
      const next = await this.enforce(entered, hypothesis, contract);
      if (typeof next !== "string")
        return { kind: "refused", phase: "hypothesis", reason: next.reason, effects: [] };
      const loops = await this.steps.loops(entered);
      const check = loops ? undefined : await this.steps.refinementCheck(entered, next);
      if (check && check.outcome !== "correct") {
        const reason = `one iteration of @${name} is not shown to keep the facts at @${hypothesis}`;
        const calls = await this.callsOf(this.store.get(head(callee, "src")), hypothesis);
        // alive2's Source and Target read as the goal's two sides, and are not.
        const explanation =
          poisonExplained(calls, hypothesis, needsValue) ??
          (check.outcome === "incorrect"
            ? "Source and Target are both the callee's src, and only Target states the facts at the call, which the example's arguments break."
            : undefined);
        return {
          kind: "refused",
          phase: "hypothesis",
          reason,
          ...(explanation ? { explanation } : {}),
          check,
          effects: [],
        };
      }
      if (check) checks.push(check);
      kept = { from: await this.store.put(entered), hash: await this.store.put(next), loops };
    }

    // Certified steps wait in a copy of the tree until every one is certified,
    // so a refusal changes nothing, and a declaration never gains an attribute
    // its definition lacks.
    const ahead = structuredClone(tree);
    const pending: Effect[] = [];
    const hold = (effects: Effect[]) => {
      for (const effect of effects) applyEffect(ahead, effect);
      pending.push(...effects);
    };
    const now = (goal: Goal) => ahead.goals.get(goal.id) as Goal;

    // Phase 1: the outer's src enforces the contract at its calls of the callee,
    // the parameter facts on its declaration and the predicates by assumes.
    // Proving that this refines `outer.src` certifies that they hold across all
    // feasible executions of the caller prefix.
    if (hasParamAttrs || hasPredicates) {
      // The function attributes are the callee's to keep, which Phase 2 asks.
      const outerSrc = this.store.get(head(outer, "src"));
      const enforced = await this.enforce(outerSrc, name, contract, "fn_attrs");
      if (typeof enforced !== "string")
        return { kind: "refused", phase: "caller", reason: enforced.reason, effects: [] };
      // A contract of facts the declaration already has adds nothing to prove.
      if ((await this.store.put(enforced)) === head(outer, "src")) {
        const reason = `the declaration of @${name} already has every fact, so there is nothing to add`;
        return { kind: "refused", phase: "caller", reason, effects: [] };
      }
      const proof = await this.steps.checkStep(ahead, outer.id, "src", enforced, { eager: false });
      if (proof.kind !== "certified") {
        const calls = await this.callsOf(this.store.get(head(outer, "src")), name);
        const explanation =
          poisonExplained(calls, name, needsValue) ??
          explainCallerRefusal(params, rawParamAttrs, proof.check, outer.id, calls[0]?.at);
        return {
          kind: "refused",
          phase: "caller",
          reason: `the facts are not shown to hold where the outer calls @${name}`,
          explanation,
          check: proof.check,
          effects: [],
        };
      }
      hold(proof.effects);
      if (proof.check) checks.push(proof.check);
      by = { gid: outer.id, hash: proof.hash };
    }

    // Phase 2: the callee's src keeps the function attributes (fn_attrs), so
    // the outer may assume them of it. The tgt needs no such check: there they
    // only add UB, which makes the callee goal harder to prove, not easier.
    if (hasFnAttrs) {
      const unannotated = this.store.get(head(callee, "src"));
      const withAttrs = await this.llops.attrs(unannotated, name, fnAttrs);
      if (!withAttrs.ok) {
        return {
          kind: "refused",
          phase: "callee_attr",
          reason: `the function attributes cannot be put on the callee's src: ${withAttrs.message}`,
          effects: [],
        };
      }
      const check = await this.steps.refinementCheck(unannotated, withAttrs.module);
      if (check.outcome !== "correct") {
        return {
          kind: "refused",
          phase: "callee_attr",
          reason: "the callee's src is not shown to keep the function attributes",
          check,
          effects: [],
        };
      }
      checks.push(check);
    }

    // Phase 2, for return facts: the callee's src, with its hypothesis
    // returning them, keeps them on its own return.
    if (hasRetAttrs) {
      const keeps = await this.keepsReturn(this.store.get(head(callee, "src")), halves, retAttrs);
      if ("reason" in keeps)
        return { kind: "refused", phase: "callee_attr", ...keeps, effects: [] };
      checks.push(keeps);
    }

    // Phase 3: the outer's tgt takes the contract Phase 1 enforced on its src,
    // so the two sides stay alike and no later step sees an assume on one side
    // alone; on the tgt it only makes the program less defined, which a tgt
    // step may always do.
    // Both sides' declarations take the function attributes. It all lands with
    // the callee's contract only once every step is certified, so the two
    // never say different things.
    for (const side of ["src", "tgt"] as Side[]) {
      // Phase 1 enforced all but the function attributes on the src, and
      // return facts alone owe the outer no step.
      if (side === "src" && !hasFnAttrs) continue;
      if (!hasParamAttrs && !hasPredicates && !hasFnAttrs) continue;
      const owed = side === "src" ? { fn_attrs: fnAttrs } : contract;
      const enforced = await this.enforce(this.store.get(head(now(outer), side)), name, owed);
      if (typeof enforced !== "string")
        return { kind: "refused", phase: "attribute", reason: enforced.reason, effects: [] };
      const step = await this.steps.checkStep(ahead, outer.id, side, enforced, { eager: false });
      if (step.kind !== "certified") {
        return {
          kind: "refused",
          phase: "attribute",
          reason: `the step that gives the outer's ${side} the interface is not certified`,
          check: step.check,
          effects: [],
        };
      }
      hold(step.effects);
      if (step.check) checks.push(step.check);
    }

    // Phase 3 (continued): Materialize contract on callee (both src and tgt).
    // Attaching parameter attributes, function attributes, and entry
    // predicates to callee definitions introduces assumptions justified by Phase 1 & 2.
    // Both sides advance simultaneously under one atomic `strengthen` effect.
    const srcRes = kept
      ? this.store.get(kept.from)
      : await this.materialize(this.store.get(head(callee, "src")), name, contract, hypothesis);
    if (typeof srcRes !== "string") return { ...srcRes, effects: [] };
    const tgtRes = await this.materialize(
      this.store.get(head(callee, "tgt")),
      name,
      contract,
      hypothesis,
    );
    if (typeof tgtRes !== "string") return { ...tgtRes, effects: [] };
    // A loop's tgt takes the contract before its calls of the hypothesis too.
    const tgtClaim = hypothesis ? await this.enforce(tgtRes, hypothesis, contract) : tgtRes;
    if (typeof tgtClaim !== "string")
      return { kind: "refused", phase: "attribute", reason: tgtClaim.reason, effects: [] };

    hold([
      {
        effect: "strengthen",
        gid: callee.id,
        src: await this.store.put(srcRes),
        tgt: await this.store.put(tgtClaim),
        ...(hasParamAttrs ? { param_attrs: rawParamAttrs } : {}),
        ...(hasFnAttrs ? { fn_attrs: fnAttrs } : {}),
        ...(hasPredicates ? { predicates } : {}),
        ...(hasRetAttrs ? { ret_attrs: retAttrs } : {}),
        ...(by ? { by: kept ? [by, { gid: callee.id, hash: kept.hash }] : [by] } : {}),
      },
    ]);

    // The outer's declarations take the return facts, which Phase 2 showed of
    // the callee's src. That is no step: on the src they add poison to the
    // call's result, which only the callee's proof excuses.
    if (hasRetAttrs) {
      const returning = await Promise.all(
        (["src", "tgt"] as Side[]).map((side) =>
          this.returning(this.store.get(head(now(outer), side)), name, retAttrs),
        ),
      );
      const [src, tgt] = returning;
      if (typeof src !== "string" || typeof tgt !== "string") {
        const reason = [src, tgt].find((side) => typeof side !== "string")?.reason ?? "";
        return { kind: "refused", phase: "attribute", reason, effects: [] };
      }
      const said = { src: await this.store.put(src), tgt: await this.store.put(tgt) };
      const before = now(outer);
      if (said.src !== head(before, "src") || said.tgt !== head(before, "tgt"))
        hold([{ effect: "strengthen", gid: outer.id, ...said, ret_attrs: retAttrs }]);
    }

    // Phase 3, for a loop: the step Phase 0 certified lands in the callee's
    // chain on that answer, so the claim never stands without it. For an
    // iteration that loops, which Phase 0 did not ask, the callee goal is
    // interposed at the program the step would make.
    if (kept && !kept.loops) {
      hold([
        { effect: "step", gid: callee.id, side: "src", to: kept.hash, how: "check", by: "alive2" },
      ]);
    } else if (kept) {
      const [lhs, rhs] = nextGoalIds(ahead);
      const [src, tgt] = [head(now(callee), "src"), head(now(callee), "tgt")];
      hold([
        {
          effect: "interpose",
          gid: callee.id,
          lhs: { gid: lhs, src, tgt: kept.hash },
          rhs: { gid: rhs, src: kept.hash, tgt },
        },
      ]);
    }
    const landed: Effect[] = [];
    this.land(tree, landed, pending);

    // Phase 4: Eager goal cross-checks.
    // Once both halves are attributed, both goals are checked. If the newly
    // established interface discharges either goal, it is settled immediately.
    for (const goal of [callee, outer]) {
      if (tree.goals.get(goal.id)?.status === "split") continue;
      const cross = await this.steps.eagerGoalCheck(tree, goal.id);
      if (cross.check) checks.push(cross.check);
      this.land(tree, landed, cross.effects);
    }
    return { kind: "strengthened", effects: landed, checks };
  }

  /**
   * The part of `contract` that strengthening the cut at goal `gid` would prove:
   * the facts that hold where the outer calls the callee and, for a loop's
   * callee, that one loop-free iteration keeps with those facts assumed at its entry.
   * Each parameter's attributes and each predicate is a fact, asked alone, and
   * nothing lands, so only `strengthen` makes one count.
   */
  async preview(
    tree: Tree,
    gid: string,
    contract: StrengthenContract,
    unroll?: number,
  ): Promise<StrengthenPreview> {
    if (Object.keys({ ...contract.fn_attrs, ...contract.ret_attrs }).length > 0)
      throw new Error("a preview takes param_attrs and predicates, not fn_attrs or ret_attrs");
    const halves = this.halves(tree, gid);
    if ("reason" in halves) return { kind: "refused", reason: halves.reason };
    const { outer, callee, name, hypothesis } = halves;
    const caller = this.store.get(head(outer, "src"));
    const entering = await this.holding(caller, name, assertionsOf(contract));
    if (!hypothesis || entering.length === 0)
      return { kind: "preview", holds: contractOf(entering) };
    const entered = await this.materialize(
      this.store.get(head(callee, "src")),
      name,
      contractOf(entering),
    );
    if (typeof entered !== "string") return { kind: "refused", reason: entered.reason };
    if (await this.steps.loops(entered)) {
      if (unroll === undefined) return { kind: "preview", holds: contractOf(entering) };
      const unbroken = await this.unbroken(entered, hypothesis, entering, unroll);
      return { kind: "preview", holds: contractOf(unbroken) };
    }
    const kept = await this.holding(entered, hypothesis, entering);
    return { kind: "preview", holds: contractOf(kept) };
  }

  /**
   * The `facts` that hold at each call of `fn` in `module`, in their order.
   * Each is a whole-function query that keeps one core busy, so they are
   * asked up to one per core at a time rather than one after another.
   */
  private async holding(module: string, fn: string, facts: Assertion[]) {
    const holds = await concurrently(facts, (fact) => this.holdsAt(module, fn, fact));
    return facts.filter((_, i) => holds[i]);
  }

  /** The `facts` no run of `unroll` iterations breaks at the calls of `fn` in `module`. */
  private async unbroken(module: string, fn: string, facts: Assertion[], unroll: number) {
    const broken = await concurrently(facts, async (fact) => {
      const enforced = await this.enforce(module, fn, contractOf([fact]));
      if (typeof enforced !== "string") return true;
      const check = await this.steps.refinementCheck(module, enforced, undefined, unroll);
      return check.outcome === "incorrect";
    });
    return facts.filter((_, i) => !broken[i]);
  }

  /** The two goals the cut at goal `gid` left, or why its interface can no longer change. */
  private halves(tree: Tree, gid: string): Halves | { reason: string } {
    const parent = tree.goals.get(gid);
    if (!parent) throw new Error(`no goal ${gid}`);
    if (parent.children.length === 0) {
      const cutBy = parent.parent ? `; strengthen ${parent.parent}, which cut it` : "";
      throw new Error(`${gid} is ${parent.status}, not cut${cutBy}`);
    }
    if (interposed(tree, parent)) throw new Error(`${gid} was interposed, not cut`);
    if (cased(tree, parent)) throw new Error(`${gid} was split by cases, not cut`);
    const outer = child(tree, parent, "outer");
    const callee = child(tree, parent, "callee");
    const name = callee.callee;
    if (!name) throw new Error(`${callee.id} does not say what it was outlined from`);
    for (const goal of [outer, callee])
      if (goal.status === "split" || goal.status === "refuted")
        return { reason: `${goal.id} is ${goal.status}, so its interface can no longer change` };
    if (outer.src_alone)
      return {
        reason: `${gid} was cut on its src alone, so its tgt has no @${name} to carry facts`,
      };
    return { outer, callee, name, hypothesis: callee.detach?.hypothesis };
  }

  /** The callee `fn` in `module` with `contract`, as Phase 3 materializes it, `hypothesis` too. */
  private async materialize(
    module: string,
    fn: string,
    contract: StrengthenContract,
    hypothesis?: string,
  ) {
    const paramAttrs = contract.param_attrs ?? {};
    const fnAttrs = contract.fn_attrs ?? {};
    const predicates = contract.predicates ?? [];
    let current = module;
    if (Object.keys(paramAttrs).length > 0 || Object.keys(fnAttrs).length > 0) {
      const attrRes = await this.attribute(current, fn, paramsOf(paramAttrs), paramAttrs, fnAttrs);
      if (typeof attrRes !== "string") return attrRes;
      current = attrRes;
    }
    if (predicates.length > 0) {
      const assumeRes = await this.llops.assume(current, { at: "start", fn }, predicates);
      if (!assumeRes.ok) {
        return {
          kind: "refused" as const,
          phase: "attribute" as const,
          reason: `the predicates cannot be added at the callee's entry: ${assumeRes.message}`,
        };
      }
      current = assumeRes.module;
    }
    const retAttrs = contract.ret_attrs ?? {};
    for (const returner of Object.keys(retAttrs).length > 0 ? [fn, hypothesis] : []) {
      const returned = returner ? await this.returning(current, returner, retAttrs) : current;
      if (typeof returned !== "string")
        return { kind: "refused" as const, phase: "attribute" as const, reason: returned.reason };
      current = returned;
    }
    return current;
  }

  /** Whether the callee's src `module` keeps `retAttrs`, given them of its hypothesis too. */
  private async keepsReturn(
    module: string,
    { name, hypothesis }: Halves,
    retAttrs: Attrs,
  ): Promise<CheckResult | { reason: string; check?: CheckResult }> {
    const assumed = hypothesis ? await this.returning(module, hypothesis, retAttrs) : module;
    if (typeof assumed !== "string") return assumed;
    if (await this.steps.loops(assumed))
      return {
        reason: `an iteration of @${name} that loops cannot be asked whether it keeps them`,
      };
    const keeps = await this.returning(assumed, name, retAttrs);
    if (typeof keeps !== "string") return keeps;
    const check = await this.steps.refinementCheck(assumed, keeps);
    if (check.outcome === "correct") return check;
    return { reason: "the callee's src is not shown to keep the return facts", check };
  }

  /** `module` with `attrs` on the return of `fn`. */
  private async returning(
    module: string,
    fn: string,
    attrs: Attrs,
  ): Promise<string | { reason: string }> {
    const result = await this.llops.attrs(module, fn, attrs, undefined, true);
    return result.ok ? result.module : { reason: `return facts: ${result.message}` };
  }

  /**
   * Whether `fact` holds at each call of `fn` in `module`: alive2 shows it when
   * the module with the fact enforced there refines the module. A noalias
   * never holds, since alive2 ignores it.
   */
  private async holdsAt(module: string, fn: string, fact: Assertion) {
    const one = contractOf([fact]);
    if (noaliasIn(one.param_attrs ?? {}) !== undefined) return false;
    const enforced = await this.enforce(module, fn, one);
    if (typeof enforced !== "string") return false;
    return (await this.steps.refinementCheck(module, enforced)).outcome === "correct";
  }

  /**
   * `module` with `contract` enforced at each call of `fn`, but for the part
   * `exclude` names: its parameter facts and function attributes on `fn`'s
   * declaration, and its predicates assumed just before each call.
   */
  private async enforce(
    module: string,
    fn: string,
    contract: StrengthenContract,
    exclude?: keyof StrengthenContract,
  ): Promise<string | { reason: string }> {
    const part = <K extends keyof StrengthenContract>(key: K) =>
      key === exclude ? undefined : contract[key];
    const paramAttrs = part("param_attrs") ?? {};
    const fnAttrs = part("fn_attrs");
    const attributed = await this.attribute(module, fn, paramsOf(paramAttrs), paramAttrs, fnAttrs);
    if (typeof attributed !== "string") return { reason: attributed.reason };
    const predicates = part("predicates") ?? [];
    if (predicates.length === 0) return attributed;
    const assumed = await this.llops.assume(attributed, { at: "before_calls", fn }, predicates);
    return assumed.ok ? assumed.module : { reason: assumed.message };
  }

  /** The program with parameter and function attributes added. */
  private async attribute(
    module: string,
    fn: string,
    params: number[],
    paramAttrs: Record<number, Attrs>,
    fnAttrs: Attrs = {},
  ): Promise<string | { kind: "refused"; phase: "attribute"; reason: string }> {
    let text = module;
    for (const param of params) {
      const result = await this.llops.attrs(text, fn, paramAttrs[param] as Attrs, param);
      if (!result.ok) {
        return {
          kind: "refused",
          phase: "attribute",
          reason: `parameter ${param}: ${result.message}`,
        };
      }
      text = result.module;
    }
    if (Object.keys(fnAttrs).length > 0) {
      const result = await this.llops.attrs(text, fn, fnAttrs);
      if (!result.ok) {
        return {
          kind: "refused",
          phase: "attribute",
          reason: `function attributes: ${result.message}`,
        };
      }
      text = result.module;
    }
    return text;
  }

  /** Each call of `fn` in a module, by the `#N` that names it, with its arguments. */
  private async callsOf(module: string, fn: string): Promise<Call[]> {
    const listed = await this.llops.number(module);
    if (!listed.ok) return [];
    return listed.body.flatMap((instruction, at) =>
      instruction.calls === `@${fn}` ? [{ at, args: instruction.args ?? [] }] : [],
    );
  }

  private land(tree: Tree, landed: Effect[], effects: Effect[]): void {
    for (const effect of effects) {
      applyEffect(tree, effect);
      landed.push(effect);
    }
  }
}

/**
 * Diagnostic explanation when the step that enforces the facts at the caller's
 * calls fails verification.
 *
 * Parses counterexamples from Alive2 to provide actionable suggestions (e.g. a poison
 * value that a fact needs defined, or directing the agent to specific analyses).
 */
export function explainCallerRefusal(
  params: number[],
  paramAttrs: Record<number, Attrs>,
  check?: CheckResult,
  outerGid?: string,
  point?: number,
): string {
  const lines: string[] = [];

  if (check?.outcome === "unknown") {
    lines.push(
      timedOut(check) ? "alive2 ran out of time." : "alive2 could not settle whether they hold.",
    );
    return lines.join("\n");
  }

  const exampleMatch = check?.detail?.match(/Example:\s*([\s\S]*?)(?:\n\s*\n|Source:|$)/i);
  const exampleLines = (exampleMatch?.[1] ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("=") || line.includes("->"));
  const exampleStr = exampleLines.join(", ");

  if (exampleStr) {
    lines.push(`The outer's example input: ${exampleStr}`);
  }

  const values = exampleLines.map(assignedValue);
  const isPoison = values.some((value) => value.includes("poison"));
  if (isPoison) {
    lines.push(
      "On that input a parameter is poison, and of the facts only range, nonnull and align hold for a poison value.",
    );
  }

  if (outerGid && params.length > 0) {
    const firstFact = paramAttrs[params[0] ?? 0] ?? {};
    const kind = firstFact.noundef ? "defined" : firstFact.range ? "ranges" : "pointer";
    lines.push(
      `To see what the outer guarantees, run goal_analyze on ${outerGid} with kind "${kind}"${point === undefined ? "" : ` and point "#${point}"`}.`,
    );
  }

  return lines.join("\n");
}

/** The two goals a cut left, the function it outlined, and its hypothesis for a loop. */
interface Halves {
  outer: Goal;
  callee: Goal;
  name: string;
  hypothesis?: string;
}

/** A call by the `#N` that names it, with its arguments. */
interface Call {
  at: number;
  args: string[];
}

/** The parameters `param_attrs` names, in order; its keys are zero-based argument indices. */
function paramsOf(paramAttrs: Record<number, Attrs>): number[] {
  const keys = Object.keys(paramAttrs);
  const bad = keys.find((key) => !/^(?:0|[1-9]\d*)$/.test(key));
  if (bad !== undefined)
    throw new Error(`param_attrs is keyed by parameter index, 0, 1, ..., not '${bad}'`);
  return keys.map(Number).sort((a, b) => a - b);
}

/** Attributes that make a value they rule out poison, so that a poison value keeps them. */
const POISON_GENERATING = new Set(["range", "nonnull", "align"]);

/** Whether every attribute in `attrs` holds of a poison value. */
function holdsOfPoison(attrs: Attrs): boolean {
  return Object.keys(attrs).every((attr) => POISON_GENERATING.has(attr));
}

/**
 * The first parameter `paramAttrs` gives noalias. alive2 ignores noalias on a
 * declaration and on a parameter, so a step that adds it proves nothing and a
 * callee that has it gains nothing.
 */
function noaliasIn(paramAttrs: Record<number, Attrs>): number | undefined {
  return paramsOf(paramAttrs).find((k) => "noalias" in (paramAttrs[k] ?? {}));
}

/** A contract's facts one at a time: each parameter's attributes, then each predicate. */
function assertionsOf(contract: StrengthenContract): Assertion[] {
  const paramAttrs = contract.param_attrs ?? {};
  const attributes = paramsOf(paramAttrs).map((p) => ({
    fact: paramAttrs[p] as Attrs,
    of: `!${p}`,
  }));
  return [...attributes, ...(contract.predicates ?? [])];
}

/** The contract that states `facts`, the inverse of `assertionsOf`. */
function contractOf(facts: Assertion[]): StrengthenContract {
  const paramAttrs: Record<number, Attrs> = {};
  const predicates: Predicate[] = [];
  for (const fact of facts)
    if ("fact" in fact) paramAttrs[Number(fact.of.slice(1))] = fact.fact;
    else predicates.push(fact);
  return {
    ...(Object.keys(paramAttrs).length > 0 ? { param_attrs: paramAttrs } : {}),
    ...(predicates.length > 0 ? { predicates } : {}),
  };
}

/** `each` of `items`, up to one per core at a time, answered in the items' order. */
async function concurrently<T, R>(items: T[], each: (item: T) => Promise<R>): Promise<R[]> {
  const answers: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      answers[i] = await each(items[i] as T);
    }
  };
  const workers = Math.min(availableParallelism(), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return answers;
}

/** The parameters a predicate names as `!N`. */
function namedIn(predicate: Predicate): number[] {
  const text =
    "insts" in predicate ? predicate.insts.join(" ") : `${predicate.lhs} ${predicate.rhs}`;
  return [...text.matchAll(/!(\d+)/g)].map((match) => Number(match[1]));
}

/** The first call that passes poison for a parameter in `needsValue`, said as a fix. */
function poisonExplained(calls: Call[], fn: string, needsValue: Set<number>): string | undefined {
  for (const { at, args } of calls) {
    const param = args.findIndex((arg, index) => arg === "poison" && needsValue.has(index));
    if (param >= 0)
      return `At #${at} the src still passes poison for parameter ${param} of @${fn}, so only a range, nonnull or align about it can hold there. Make the src pass a real value at that call first.`;
  }
  return undefined;
}

/** The value an example line assigns, which is what follows the first '=' or '->'. */
function assignedValue(line: string): string {
  const eq = line.indexOf("=");
  const arrow = line.indexOf("->");
  const cut = eq === -1 ? arrow : arrow === -1 ? eq : Math.min(eq, arrow);
  return cut === -1 ? line.trim() : line.slice(cut + (line[cut] === "-" ? 2 : 1)).trim();
}
