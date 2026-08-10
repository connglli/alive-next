// Strengthening a cut's interface.
//
// Outlining loses whatever the prefix knew about the values it passes, so a
// callee goal can be false for want of a fact its caller could have supplied.
// Putting that fact back is two phases, and they are not the same kind of
// thing.
//
// Phase one proves the fact where the evidence is, by inserting an assume
// before the call in the outer src and certifying that as an ordinary step. If
// the fact is false the assume adds UB the program did not have and alive2
// refuses it, which is what makes the whole recipe sound.
//
// Phase two puts the attribute on the outlined function's parameters, in four
// programs. The outer's two are ordinary steps, cheap now that the assumes are
// there. The callee's two are not steps at all: an attribute on a definition
// introduces UB where the old program was defined, so no direction of a
// refinement check would certify it. They move together, recorded as one
// strengthen effect naming the step that justifies them.
//
// One call carries as many parameters as the caller has facts for, because an
// interface is strengthened as a whole. The solver cost is the same for one
// parameter or for all of them: three certified steps and the two cross-checks
// at the end, whatever the count.
import type { CheckResult } from "../drivers/alive2.ts";
import type { Llops } from "../drivers/llops.ts";
import { applyEffect, type Goal, head, type Side, type Tree } from "./goals.ts";
import type { Steps } from "./steps.ts";
import type { Store } from "./store.ts";
import type { Effect } from "./trajectory.ts";

/** A fact, in the vocabulary `llops edit attrs` and `llops assume` share. */
export type Fact = Record<string, unknown>;

/** What an interface is to gain, by parameter position. */
export type Facts = Record<number, Fact>;

export type StrengthenResult =
  | { kind: "strengthened"; effects: Effect[]; checks: CheckResult[] }
  | {
      kind: "refused";
      /** Which half gave up, so the agent knows what it is looking at. */
      phase: "assume" | "attribute";
      reason: string;
      /** What alive2 said, when it was alive2 that refused. */
      check?: CheckResult;
      /** What did land before the refusal, which the head already reflects. */
      effects: Effect[];
    };

export class Strengthen {
  constructor(
    private readonly store: Store,
    private readonly llops: Llops,
    private readonly steps: Steps,
  ) {}

  /**
   * Put each fact on the parameter it names, of the function `gid` was cut at.
   * `gid` is the split goal, so both halves of the cut are reachable from it.
   *
   * The tree is advanced as each record lands, because a phase two failure
   * leaves real work behind: the assumes are proved and stay proved, and the
   * agent reverts what it does not want.
   *
   * The steps inside carry no cross-check of their own. Between the two halves
   * the outer's two sides declare the outlined function differently, and that
   * is a state to pass through rather than one to ask about; both goals are
   * checked once at the end instead.
   */
  async strengthen(tree: Tree, gid: string, facts: Facts): Promise<StrengthenResult> {
    const params = Object.keys(facts)
      .map(Number)
      .sort((a, b) => a - b);
    if (params.length === 0) throw new Error(`${gid}: no facts to state`);
    const parent = tree.goals.get(gid);
    if (!parent) throw new Error(`no goal ${gid}`);
    // A goal that was cut, whether or not its children have discharged it
    // since: a second fact is an ordinary thing to want, and the proof those
    // children carried comes undone as they are touched, the way a step undoes
    // one. A goal that was never cut, or whose cut was undone, has no
    // interface to strengthen.
    if (parent.children.length === 0) {
      throw new Error(`${gid} is ${parent.status}, not split`);
    }
    const outer = child(tree, parent, "outer");
    const callee = child(tree, parent, "callee");
    const name = callee.callee;
    if (!name) throw new Error(`${callee.id} does not say what it was outlined from`);

    // A proved child is no obstacle: touching it reopens it, since the proof
    // was about the pair being replaced. A cut or refuted one is, and the
    // agent can reach that state itself, so it gets an answer to read.
    for (const goal of [outer, callee]) {
      if (goal.status === "split" || goal.status === "refuted") {
        return {
          kind: "refused",
          phase: "assume",
          reason: `${goal.id} is ${goal.status}, so it cannot take the attribute`,
          effects: [],
        };
      }
    }

    const landed: Effect[] = [];
    const checks: CheckResult[] = [];

    // Phase one, where the proof cost is. Every fact is assumed before the
    // call, and the whole set goes to alive2 as one step: a caller either
    // honours the interface it is asked for or it does not.
    let assumed = this.store.get(head(outer, "src"));
    for (const param of params) {
      const one = await this.llops.assume(assumed, {
        before_call: name,
        arg: param,
        fact: facts[param] as Fact,
      });
      if (!one.ok) {
        return {
          kind: "refused",
          phase: "assume",
          reason: `parameter ${param}: ${one.message}`,
          effects: landed,
        };
      }
      assumed = one.module;
    }
    const proof = await this.steps.step(tree, outer.id, "src", assumed, { eager: false });
    if (proof.kind !== "certified") {
      // A fact does not hold, or nothing here shows that it does.
      return {
        kind: "refused",
        phase: "assume",
        reason: "the assumes were not certified",
        check: proof.check,
        effects: landed,
      };
    }
    this.land(tree, landed, proof.effects);
    checks.push(proof.check);
    const by = { gid: outer.id, hash: proof.hash };

    // Phase two on the outer: both sides declare the same signature for the
    // outlined function, so both sides change, each as its own step.
    for (const side of ["src", "tgt"] as Side[]) {
      const attributed = await this.attribute(
        this.store.get(head(outer, side)),
        name,
        params,
        facts,
      );
      if (typeof attributed !== "string") return { ...attributed, effects: landed };
      const step = await this.steps.step(tree, outer.id, side, attributed, { eager: false });
      if (step.kind !== "certified") {
        return {
          kind: "refused",
          phase: "attribute",
          reason: `the attributes on the outer ${side} were not certified`,
          check: step.check,
          effects: landed,
        };
      }
      this.land(tree, landed, step.effects);
      checks.push(step.check);
    }

    // Phase two on the callee: one claim, both sides, no solver.
    const src = await this.attribute(this.store.get(head(callee, "src")), name, params, facts);
    if (typeof src !== "string") return { ...src, effects: landed };
    const tgt = await this.attribute(this.store.get(head(callee, "tgt")), name, params, facts);
    if (typeof tgt !== "string") return { ...tgt, effects: landed };

    this.land(tree, landed, [
      {
        effect: "strengthen",
        gid: callee.id,
        src: await this.store.put(src),
        tgt: await this.store.put(tgt),
        by,
      },
    ]);

    // Both goals are checked once, at the end, so that whatever this made
    // provable is discharged here rather than left for the agent to ask about.
    // Not before the end: between the two halves the outer's sides declare the
    // outlined function differently, which is not a pair worth asking about.
    // The callee comes first, since making it provable is the point.
    for (const goal of [callee, outer]) {
      const cross = await this.steps.crossCheck(tree, goal.id);
      checks.push(cross.check);
      this.land(tree, landed, cross.effects);
    }
    return { kind: "strengthened", effects: landed, checks };
  }

  /** The program with every attribute added, or why llops would not add one. */
  private async attribute(
    module: string,
    fn: string,
    params: number[],
    facts: Facts,
  ): Promise<string | { kind: "refused"; phase: "attribute"; reason: string }> {
    let text = module;
    for (const param of params) {
      const result = await this.llops.edit(text, {
        op: "attrs",
        fn,
        param,
        attrs: facts[param] as Fact,
      });
      if (!result.ok) {
        return {
          kind: "refused",
          phase: "attribute",
          reason: `parameter ${param}: ${result.message}`,
        };
      }
      text = result.module;
    }
    return text;
  }

  private land(tree: Tree, landed: Effect[], effects: Effect[]): void {
    for (const effect of effects) {
      applyEffect(tree, effect);
      landed.push(effect);
    }
  }
}

function child(tree: Tree, parent: Goal, role: "outer" | "callee"): Goal {
  for (const id of parent.children) {
    const goal = tree.goals.get(id);
    if (goal?.role === role) return goal;
  }
  throw new Error(`${parent.id} has no ${role} child`);
}
