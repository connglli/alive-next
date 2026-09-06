// The manifest: what a run earned, pruned to what settled the root.
//
// This is the whole of what a certificate says, and scripts/check.py is the
// only reader that matters. Nothing here is a claim on its own. A proof's
// every step names the pair it moved and the side it moved, and the checker
// reruns the check that certified it, in the direction the side implies. A
// counterexample names the pair the run was asked about and one input, and the
// checker runs them itself.
//
// What the run abandoned does not appear. A goal's chain is the path from the
// pair it started with to the pair it ended with, which is what the goal tree
// holds after reverts have truncated it.
import type { Attrs, HarnessArg, PredicateAssertion } from "../core/drivers/llops.ts";
import type { LlrwtInvocation } from "../core/drivers/llrwt.ts";
import { type Goal, head, type Tree } from "../core/state/goals.ts";
import type { Effect, Entry, Hash } from "../core/state/trajectory.ts";

export const VERSION = 1;

/** One move along a goal's chain. */
export type Step =
  | {
      kind: "checked";
      side: "src" | "tgt";
      from: Hash;
      to: Hash;
    }
  /**
   * A step the verified rewriter certified: the rules it ran and exactly what
   * it ran them under. A checker reruns the same invocation and compares
   * bytes, asking no solver anything.
   */
  | {
      kind: "rule";
      side: "src";
      from: Hash;
      to: Hash;
      rules: string[];
      invocation: LlrwtInvocation;
    }
  /**
   * A step whose check was narrowed to the window the edit touched. The two
   * halves share one outer, and inlining each back into it is what says the
   * rest of the body is untouched, so what a checker reruns is that and the
   * small pair rather than the whole function.
   */
  | {
      kind: "window";
      side: "src" | "tgt";
      from: Hash;
      to: Hash;
      window: {
        callee: string;
        outer: Hash;
        from: Hash;
        to: Hash;
        preconditions?: Record<string, Record<string, unknown>>;
      };
    }
  /**
   * An interface was strengthened: the callee gained parameter attributes,
   * function attributes, and/or entry relational predicates.
   */
  | {
      kind: "strengthen";
      from: Pair;
      to: Pair;
      param_attrs?: Record<number, Attrs>;
      fn_attrs?: Attrs;
      predicates?: PredicateAssertion[];
      by?: { gid: string; hash: Hash };
    };

export interface Pair {
  src: Hash;
  tgt: Hash;
}

/** How a goal was discharged. */
export type Discharge =
  | { kind: "checked" }
  | { kind: "split"; callee: string; outer: string; inner: string };

/** One goal in a proof, from the pair it started with to the one it proved. */
export interface ManifestGoal {
  /** The pair the goal started with, which is what it proves about. */
  start: Pair;
  steps: Step[];
  /** The pair it ended with, which every step above adds up to. */
  end: Pair;
  discharge: Discharge;
}

/** A whole proof: every goal that was proved, and the moves that proved it. */
export interface Proof {
  version: number;
  verdict: "verified";
  root: string;
  /** The binaries the run used, as `run_start` recorded them. */
  toolchain: unknown;
  goals: Record<string, ManifestGoal>;
}

/** A refutation: one input, and the pair it was run on. */
export interface Counterexample {
  version: number;
  verdict: "counterexample";
  root: string;
  toolchain: unknown;
  /** The pair the run was asked about, which is what the input refutes. */
  pair: Pair;
  /** The argument values, as `llops harness` takes them. */
  input: HarnessArg[];
  /** What the run saw, which a checker recomputes rather than believes. */
  divergence: string;
}

export type Manifest = Proof | Counterexample;

export class NotCertifiable extends Error {
  constructor(message: string) {
    super(`certificate: ${message}`);
    this.name = "NotCertifiable";
  }
}

/**
 * The manifest for a settled run, and the programs it refers to.
 *
 * The tree says which pairs survived; the log says what certified each move.
 */
export function manifestOf(entries: Entry[], tree: Tree): [Manifest, Set<Hash>] {
  const root = tree.goals.get(tree.root);
  if (!root) throw new NotCertifiable("the run has no root goal");
  if (root.status === "refuted") return refutation(entries, tree, root);
  if (root.status !== "proved") {
    throw new NotCertifiable(`the root is ${root.status}, so there is nothing to certify`);
  }
  const effects = effectsOf(entries);
  const goals: Record<string, ManifestGoal> = {};
  const programs = new Set<Hash>();
  include(tree, root, effects, goals, programs);
  return [
    {
      version: VERSION,
      verdict: "verified" as const,
      root: tree.root,
      toolchain: toolchainOf(entries),
      goals,
    },
    programs,
  ];
}

/**
 * The manifest for a refuted run: the pair it was asked about, and the input
 * the framework saw them diverge on.
 *
 * The steps a run made before the refutation are not part of it. A
 * counterexample is against the original pair, since that is the pair the
 * interpreter was given and the only one the verdict is about.
 */
function refutation(entries: Entry[], tree: Tree, root: Goal): [Counterexample, Set<Hash>] {
  const report = reportOf(entries, root.id);
  const pair = { src: first(root, "src"), tgt: first(root, "tgt") };
  return [
    {
      version: VERSION,
      verdict: "counterexample",
      root: tree.root,
      toolchain: toolchainOf(entries),
      pair,
      input: report.input,
      divergence: report.divergence,
    },
    new Set([pair.src, pair.tgt]),
  ];
}

/** The report that refuted the root, which is the last one that did. */
function reportOf(entries: Entry[], gid: string): { input: HarnessArg[]; divergence: string } {
  let found: { input: HarnessArg[]; divergence: string } | undefined;
  for (const entry of entries) {
    if (entry.kind !== "tool_result") continue;
    const refuted = (entry.effects ?? []).some(
      (effect) => effect.effect === "refuted" && effect.gid === gid,
    );
    if (!refuted) continue;
    const result = entry.result as { input?: HarnessArg[]; divergence?: string } | null;
    if (!result?.input) continue;
    found = { input: result.input, divergence: result.divergence ?? "" };
  }
  if (!found) throw new NotCertifiable(`nothing in the log says which input refuted ${gid}`);
  return found;
}

/** Walk what discharged the root, and nothing else. */
function include(
  tree: Tree,
  goal: Goal,
  effects: Effect[],
  goals: Record<string, ManifestGoal>,
  programs: Set<Hash>,
): void {
  const start = { src: first(goal, "src"), tgt: first(goal, "tgt") };
  const end = { src: head(goal, "src"), tgt: head(goal, "tgt") };
  const steps = chainOf(goal, effects);
  for (const hash of [...goal.src.history, ...goal.tgt.history]) programs.add(hash);
  // A narrowed step is replayed from its three halves, so they travel with the
  // pairs the goal held rather than being recoverable only from the run.
  for (const step of steps)
    if (step.kind === "window")
      for (const hash of [step.window.outer, step.window.from, step.window.to]) programs.add(hash);

  if (goal.children.length === 0) {
    goals[goal.id] = { start, steps, end, discharge: { kind: "checked" } };
    return;
  }
  const outer = childOf(tree, goal, "outer");
  const inner = childOf(tree, goal, "callee");
  if (!goal.callee && !outer.callee) {
    throw new NotCertifiable(`${goal.id} was cut without naming the function it made`);
  }
  goals[goal.id] = {
    start,
    steps,
    end,
    discharge: {
      kind: "split",
      callee: (outer.callee ?? goal.callee) as string,
      outer: outer.id,
      inner: inner.id,
    },
  };
  include(tree, outer, effects, goals, programs);
  include(tree, inner, effects, goals, programs);
}

/**
 * The moves along a goal's surviving chain, in the order they happened.
 *
 * The log holds every move the run made, the abandoned ones included, and the
 * goal holds the pairs that survived. Walking the log and taking each move
 * that lands on the next surviving pair is what leaves the path.
 */
function chainOf(goal: Goal, effects: Effect[]): Step[] {
  const steps: Step[] = [];
  const src = goal.src.history;
  const tgt = goal.tgt.history;
  let si = 1;
  let ti = 1;
  for (const effect of effects) {
    if (effect.gid !== goal.id) continue;
    if (effect.effect === "step" && effect.to === goal[effect.side].history[side(effect, si, ti)]) {
      const from = goal[effect.side].history[side(effect, si, ti) - 1] as Hash;
      // TODO: Support tgt->src rewrites (some kind of anti-optimizations).
      if (effect.how === "rule") {
        if (effect.side !== "src") {
          throw new NotCertifiable(
            `a rule step on ${goal.id} was recorded on ${effect.side}, but rules optimize forward on src only`,
          );
        }
        if (!effect.rules || effect.rules.length === 0) {
          throw new NotCertifiable(`a rule step on ${goal.id} names no rules`);
        }
        if (!effect.invocation) {
          throw new NotCertifiable(`a rule step on ${goal.id} records no invocation`);
        }
        steps.push({
          kind: "rule",
          side: effect.side,
          from,
          to: effect.to,
          rules: effect.rules,
          invocation: effect.invocation,
        });
      } else {
        steps.push(
          effect.window
            ? {
                kind: "window",
                side: effect.side,
                from,
                to: effect.to,
                window: effect.window,
              }
            : {
                kind: "checked",
                side: effect.side,
                from,
                to: effect.to,
              },
        );
      }
      if (effect.side === "src") si += 1;
      else ti += 1;
    } else if (effect.effect === "strengthen" && effect.src === src[si] && effect.tgt === tgt[ti]) {
      steps.push({
        kind: "strengthen",
        from: { src: src[si - 1] as Hash, tgt: tgt[ti - 1] as Hash },
        to: { src: effect.src, tgt: effect.tgt },
        ...(effect.param_attrs ? { param_attrs: effect.param_attrs } : {}),
        ...(effect.fn_attrs ? { fn_attrs: effect.fn_attrs } : {}),
        ...(effect.predicates ? { predicates: effect.predicates } : {}),
        ...(effect.by ? { by: effect.by } : {}),
      });
      si += 1;
      ti += 1;
    }
  }
  if (si !== src.length || ti !== tgt.length) {
    throw new NotCertifiable(`nothing in the log accounts for every pair ${goal.id} held`);
  }
  return steps;
}

/** Which index a step is a candidate for, on the side it moves. */
function side(effect: { side: "src" | "tgt" }, si: number, ti: number): number {
  return effect.side === "src" ? si : ti;
}

function first(goal: Goal, side: "src" | "tgt"): Hash {
  const start = goal[side].history[0];
  if (start === undefined) throw new NotCertifiable(`${goal.id} has no ${side} program`);
  return start;
}

function childOf(tree: Tree, parent: Goal, role: "outer" | "callee"): Goal {
  for (const id of parent.children) {
    const child = tree.goals.get(id);
    if (child?.role === role) return child;
  }
  throw new NotCertifiable(`${parent.id} has no ${role} child`);
}

/** Every effect the log recorded, in order. */
function effectsOf(entries: Entry[]): Effect[] {
  const effects: Effect[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool_result") continue;
    for (const effect of entry.effects ?? []) {
      effects.push(effect);
    }
  }
  return effects;
}

function toolchainOf(entries: Entry[]): unknown {
  const start = entries.find((entry) => entry.kind === "run_start");
  return start && "toolchain" in start ? start.toolchain : undefined;
}
