// Strengthening a cut's interface.
//
// Outlining cuts a large program into an outer caller and an outlined callee.
// This decomposition loses facts the caller prefix established about the live-in
// values crossing the cut boundary. As a result, an outlined callee goal may be
// unprovable on its own without interface facts the caller actually guarantees.
//
// Strengthening enriches the cut boundary with three categories of contract facts:
//
// 1. Parameter Attributes (`param_attrs`):
//    Per-argument properties on callee parameters (e.g. `noundef`, `range`,
//    `align`, `nonnull`, `dereferenceable`).
//
// 2. Relational Preconditions (`predicates`):
//    Relational comparisons across arguments at the cut boundary (e.g. `%0 < %1`,
//    `%p != null`).
//
// 3. Function Semantic Attributes (`fn_attrs`):
//    Function-level guarantees about the callee's behavior (e.g. `memory(none)`,
//    `nounwind`, `willreturn`, `nofree`).
//
// Verification proceeds in three certified phases:
//
// Phase one (caller preconditions): preconditions (`param_attrs` and `predicates`)
// are inserted as `llvm.assume` instructions immediately before the `@callee` call
// site in `outer.src`. Alive2 verifies this whole-program step. If an assumption is
// false on any feasible execution, `llvm.assume` introduces undefined behavior where
// the original program was defined, causing Alive2 to refute the step.
//
// Phase two (callee guarantees): semantic function attributes (`fn_attrs`) are verified
// on the callee bodies via refinement checks (`unannotated => with_fn_attrs`). Checking
// both `src` and `tgt` ensures neither side performs behavior forbidden by the attribute
// (which would introduce UB into `src` and unsoundly validate invalid targets).
//
// Phase three (contract materialization): caller declarations (`outer.src` and `outer.tgt`)
// are updated with the certified parameter and function attributes. Callee definitions
// (`callee.src` and `callee.tgt`) gain the parameter attributes, function attributes,
// and entry relational predicates. This transition is recorded as an atomic `strengthen`
// effect linked to the justifying caller step (`by`).
import type { CheckResult } from "../drivers/alive2.ts";
import type { Assertion, Attrs, Llops, PredicateAssertion } from "../drivers/llops.ts";
import { applyEffect, type Goal, head, type Side, type Tree } from "./goals.ts";
import type { Steps } from "./steps.ts";
import type { Store } from "./store.ts";
import type { Effect, Hash } from "./trajectory.ts";

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
  /** Relational comparison preconditions conjoined at the cut boundary. */
  predicates?: PredicateAssertion[];
}

export type StrengthenResult =
  | { kind: "strengthened"; effects: Effect[]; checks: CheckResult[] }
  | {
      kind: "refused";
      /** Which validation phase failed, identifying why the proposal was rejected. */
      phase: "assume" | "attribute" | "callee_attr";
      reason: string;
      /** Detailed diagnostic explanation for humans and agents. */
      explanation?: string;
      /** The solver result when Alive2 refused the step. */
      check?: CheckResult;
      /** Steps that landed before the refusal, already reflected in the tree head. */
      effects: Effect[];
    };

export class Strengthen {
  constructor(
    private readonly store: Store,
    private readonly llops: Llops,
    private readonly steps: Steps,
  ) {}

  /**
   * Strengthen the interface of the outlined function at split goal `gid`.
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

    // Parameter attributes are keyed by zero-based argument index.
    const keys = Object.keys(rawParamAttrs);
    const bad = keys.find((key) => !/^(?:0|[1-9]\d*)$/.test(key));
    if (bad !== undefined)
      throw new Error(
        `${gid}: '${bad}' is not a parameter position; parameter attributes are keyed by index (0, 1, ...)`,
      );
    const params = keys.map(Number).sort((a, b) => a - b);
    const hasParamAttrs = params.length > 0;
    const hasFnAttrs = Object.keys(fnAttrs).length > 0;
    const hasPredicates = predicates.length > 0;

    if (!hasParamAttrs && !hasFnAttrs && !hasPredicates) {
      throw new Error(
        `${gid}: no parameter attributes, function attributes, or predicates to strengthen`,
      );
    }

    const parent = tree.goals.get(gid);
    if (!parent) throw new Error(`no goal ${gid}`);
    if (parent.children.length === 0) {
      throw new Error(`${gid} is ${parent.status}, not split`);
    }
    const outer = child(tree, parent, "outer");
    const callee = child(tree, parent, "callee");
    const name = callee.callee;
    if (!name) throw new Error(`${callee.id} does not say what it was outlined from`);

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
    let by: { gid: string; hash: Hash } | undefined;

    // Phase 1: Prove caller preconditions (param_attrs & predicates) in outer src.
    // Preconditions are inserted as `llvm.assume` before the `@callee` call site.
    // Proving `outer.src + assumes <= outer.src` certifies that the assumptions
    // hold across all feasible executions of the caller prefix.
    if (hasParamAttrs || hasPredicates) {
      const assertions: Assertion[] = [
        ...params.map((p) => ({ fact: rawParamAttrs[p] as Attrs, arg: p })),
        ...predicates,
      ];
      const one = await this.llops.assume(
        this.store.get(head(outer, "src")),
        { at: "before_call", fn: name },
        assertions,
      );
      if (!one.ok) {
        return {
          kind: "refused",
          phase: "assume",
          reason: one.message,
          effects: landed,
        };
      }
      const assumed = one.module;
      const proof = await this.steps.checkStep(tree, outer.id, "src", assumed, { eager: false });
      if (proof.kind !== "certified") {
        const explanation = explainAssumeRefusal(params, rawParamAttrs, proof.check, outer.id);
        return {
          kind: "refused",
          phase: "assume",
          reason: "the assumes were not certified",
          explanation,
          check: proof.check,
          effects: landed,
        };
      }
      this.land(tree, landed, proof.effects);
      checks.push(proof.check);
      by = { gid: outer.id, hash: proof.hash };
    }

    // Phase 2: Verify callee function attributes (fn_attrs) on both sides.
    // Function attributes assert behavioral guarantees (e.g. `memory(none)`).
    // If a body violates the attribute (e.g. writes memory), adding the attribute
    // causes undefined behavior on that execution. Checking `unannotated => with_attrs`
    // on both `callee.src` and `callee.tgt` ensures neither side introduces UB.
    if (hasFnAttrs) {
      for (const side of ["src", "tgt"] as Side[]) {
        const unannotated = this.store.get(head(callee, side));
        const withAttrs = await this.llops.edit(unannotated, {
          op: "attrs",
          fn: name,
          attrs: fnAttrs,
        });
        if (!withAttrs.ok) {
          return {
            kind: "refused",
            phase: "callee_attr",
            reason: `cannot apply function attributes to callee ${side}: ${withAttrs.message}`,
            effects: landed,
          };
        }
        const check = await this.steps.refinementCheck(unannotated, withAttrs.module);
        if (check.outcome !== "correct") {
          return {
            kind: "refused",
            phase: "callee_attr",
            reason: `callee ${side} does not satisfy function attributes: ${check.outcome}`,
            check,
            effects: landed,
          };
        }
        checks.push(check);
      }
    }

    // Phase 3: Materialize attributes on outer (both src and tgt).
    // The callee declaration in the outer caller gains parameter and function
    // attributes. In `outer.src`, this is certified against the assumes proven in
    // Phase 1; in `outer.tgt`, the caller steps forward along the refinement order.
    if (hasParamAttrs || hasFnAttrs) {
      for (const side of ["src", "tgt"] as Side[]) {
        const attributed = await this.attribute(
          this.store.get(head(outer, side)),
          name,
          params,
          rawParamAttrs,
          fnAttrs,
        );
        if (typeof attributed !== "string") return { ...attributed, effects: landed };
        const step = await this.steps.checkStep(tree, outer.id, side, attributed, { eager: false });
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
    }

    // Phase 3 (continued): Materialize contract on callee (both src and tgt).
    // Attaching parameter attributes, function attributes, and entry relational
    // predicates to callee definitions introduces assumptions justified by Phase 1 & 2.
    // Both sides advance simultaneously under one atomic `strengthen` effect.
    const applyToCallee = async (mod: string) => {
      let current = mod;
      if (hasParamAttrs || hasFnAttrs) {
        const attrRes = await this.attribute(current, name, params, rawParamAttrs, fnAttrs);
        if (typeof attrRes !== "string") return attrRes;
        current = attrRes;
      }
      if (hasPredicates) {
        const assumeRes = await this.llops.assume(current, { at: "entry", fn: name }, predicates);
        if (!assumeRes.ok) {
          return {
            kind: "refused" as const,
            phase: "attribute" as const,
            reason: `entry predicates failed on callee: ${assumeRes.message}`,
          };
        }
        current = assumeRes.module;
      }
      return current;
    };

    const srcRes = await applyToCallee(this.store.get(head(callee, "src")));
    if (typeof srcRes !== "string") return { ...srcRes, effects: landed };
    const tgtRes = await applyToCallee(this.store.get(head(callee, "tgt")));
    if (typeof tgtRes !== "string") return { ...tgtRes, effects: landed };

    this.land(tree, landed, [
      {
        effect: "strengthen",
        gid: callee.id,
        src: await this.store.put(srcRes),
        tgt: await this.store.put(tgtRes),
        ...(hasParamAttrs ? { param_attrs: rawParamAttrs } : {}),
        ...(hasFnAttrs ? { fn_attrs: fnAttrs } : {}),
        ...(hasPredicates ? { predicates } : {}),
        ...(by ? { by } : {}),
      },
    ]);

    // Phase 4: Eager goal cross-checks.
    // Once both halves are attributed, both goals are checked. If the newly
    // established interface discharges either goal, it is settled immediately.
    for (const goal of [callee, outer]) {
      const cross = await this.steps.eagerGoalCheck(tree, goal.id);
      checks.push(cross.check);
      this.land(tree, landed, cross.effects);
    }
    return { kind: "strengthened", effects: landed, checks };
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
      const result = await this.llops.edit(text, {
        op: "attrs",
        fn,
        param,
        attrs: paramAttrs[param] as Attrs,
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
    if (Object.keys(fnAttrs).length > 0) {
      const result = await this.llops.edit(text, {
        op: "attrs",
        fn,
        attrs: fnAttrs,
      });
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

/**
 * Diagnostic explanation when an assume step fails verification in the caller.
 *
 * Parses counterexamples from Alive2 to provide actionable suggestions (e.g. poison
 * values triggering UB under llvm.assume, or directing the agent to specific analyses).
 */
export function explainAssumeRefusal(
  params: number[],
  paramAttrs: Record<number, Attrs>,
  check?: CheckResult,
  outerGid?: string,
): string {
  const header =
    params.length === 0
      ? "The relational preconditions do not hold in the caller."
      : params.length === 1
        ? `The assumption on parameter ${params[0]} does not hold in the caller.`
        : `The assumptions on parameter(s) ${params.join(", ")} do not hold in the caller.`;

  const lines: string[] = [header];

  if (check?.outcome === "unknown") {
    lines.push(
      check.detail.startsWith("killed after")
        ? "Checking the assumptions ran out of time in the solver."
        : "The solver could not settle whether the assumptions hold.",
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
    lines.push(`Caller counterexample: ${exampleStr}`);
  }

  const values = exampleLines.map(assignedValue);
  const isPoison = values.some((value) => value.includes("poison"));
  if (isPoison) {
    lines.push(
      `On caller input ${exampleStr}, a parameter evaluates to poison, which triggers undefined behavior under llvm.assume.`,
    );
  }

  if (outerGid && params.length > 0) {
    const firstFact = paramAttrs[params[0] ?? 0] ?? {};
    const kind = firstFact.noundef ? "defined" : firstFact.range ? "ranges" : "pointer";
    lines.push(
      `Hint: run goal_analyze on outer goal '${outerGid}' with kind: "${kind}" to inspect what facts the caller actually guarantees before strengthening.`,
    );
  }

  return lines.join("\n");
}

/** The value an example line assigns, which is what follows the first '=' or '->'. */
function assignedValue(line: string): string {
  const eq = line.indexOf("=");
  const arrow = line.indexOf("->");
  const cut = eq === -1 ? arrow : arrow === -1 ? eq : Math.min(eq, arrow);
  return cut === -1 ? line.trim() : line.slice(cut + (line[cut] === "-" ? 2 : 1)).trim();
}
