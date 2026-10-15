// The manifest: what a run earned, pruned to what settled the root.
//
// This is the whole of what a certificate says, and kernel/check.py is the
// only reader that matters. Nothing here is a claim on its own. A proof's
// every step names the pair it moved and the side it moved, and the checker
// reruns the check that certified it, in the direction the side implies. A
// counterexample names the pair the run was asked about, the input it was
// refuted at when there is one, and the checker: alive2, or llubi where alive2
// did not decide.
//
// What the run abandoned does not appear. A goal's chain is the path from the
// pair it started with to the pair it ended with, which is what the goal tree
// holds after reverts have truncated it.
import type { Attrs, InputArg, Predicate } from "../core/drivers/llops.ts";
import type { LlrwtInvocation } from "../core/drivers/llrwt.ts";
import type { ReportResult } from "../core/state/counterexamples.ts";
import { type Goal, head, interposed, type Role, type Tree } from "../core/state/goals.ts";
import type { CheckGoalResult } from "../core/state/steps.ts";
import type {
  Detach,
  Effect,
  Entry,
  FrameworkEvent,
  Hash,
  StepRef,
  ToolResultEvent,
} from "../core/state/trajectory.ts";

export const VERSION = 1;

/** One move along a goal's chain. */
export type Step =
  /**
   * A step a checker certified, in the direction the side implies: alive2, or
   * `llops reshaped` or `llops respected`, which ask no solver, when the step
   * only reshaped control flow or changed attributes.
   */
  | {
      kind: "check";
      side: "src" | "tgt";
      from: Hash;
      to: Hash;
      by: "alive2" | "reshaped" | "respected";
    }
  /**
   * A step the verified rewriter certified: the rules it ran and exactly what
   * it ran them under. A checker reruns the same invocation and compares
   * bytes, asking no solver anything.
   */
  | {
      kind: "rewrite";
      side: "src";
      from: Hash;
      to: Hash;
      rules: string[];
      invocation: LlrwtInvocation;
    }
  /**
   * A step whose check was narrowed to the window the edit touched. The two
   * halves share one outer, and inlining each back into it shows the rest of
   * the body is untouched, so a checker reruns that and the small pair rather
   * than the whole function.
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
   * A detached loop's body put at each call of its hypothesis. Both bodies
   * define the same loop, so a checker unfolds `from` again and compares
   * bytes, asking no solver anything.
   */
  | {
      kind: "unfold";
      side: "src" | "tgt";
      from: Hash;
      to: Hash;
    }
  /**
   * An interface was strengthened: the callee gained parameter attributes,
   * function attributes, and/or entry predicates.
   */
  | {
      kind: "strengthen";
      from: Pair;
      to: Pair;
      param_attrs?: Record<number, Attrs>;
      fn_attrs?: Attrs;
      predicates?: Predicate[];
      by?: StepRef[];
    };

export interface Pair {
  src: Hash;
  tgt: Hash;
}

/** How a goal was discharged. */
export type Discharge =
  /** The pair was checked, by alive2, `llops reshaped` or `llops respected`, as a step is. */
  | { kind: "check"; by: "alive2" | "reshaped" | "respected" }
  /**
   * A program was put between the pair: goal `lhs` holds the src and the
   * program, goal `rhs` the program and the tgt, and a checker checks that
   * both start there and verify, since refinement is transitive.
   */
  | { kind: "interpose"; program: Hash; lhs: string; rhs: string }
  | {
      kind: "split";
      callee: string;
      outer: string;
      inner: string;
      detach?: Detach;
    };

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
  /** The binaries the run used, as `start` recorded them. */
  toolchain: unknown;
  goals: Record<string, ManifestGoal>;
}

/** A refutation: the pair it refutes, and its source. */
export interface Counterexample {
  version: number;
  verdict: "counterexample";
  root: string;
  toolchain: unknown;
  /** alive2, or llubi where alive2 did not decide. */
  source: "llubi" | "alive2";
  /** The pair the run was asked about, which is what the refutation is of. */
  pair: Pair;
  /** The argument values, as `llops instantiate` and `llops harness` take them. */
  input?: InputArg[];
  /** How many times alive2 unrolled each loop. */
  unroll?: number;
  /** What diverged, in the words of the checker that refuted the pair. */
  divergence?: string;
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
 * The manifest for a refuted run: the pair the run was asked about, the input
 * and unroll factor it was refuted at when a report named them, and the
 * checker that refuted it.
 *
 * The steps a run made before the refutation are not part of it. The last
 * entry that refuted the root wins.
 */
function refutation(entries: Entry[], tree: Tree, root: Goal): [Counterexample, Set<Hash>] {
  const pair = { src: first(root, "src"), tgt: first(root, "tgt") };
  let refuted: Refuted | undefined;
  for (const entry of entries) {
    if (entry.kind !== "tool_result" && entry.kind !== "framework") continue;
    if (refutedEffect(entry, root.id)) refuted = refutedBy(entry);
  }
  if (refuted === undefined) throw new NotCertifiable(`nothing in the log refuted ${root.id}`);
  return [
    {
      version: VERSION,
      verdict: "counterexample" as const,
      root: tree.root,
      toolchain: toolchainOf(entries),
      ...refuted,
      pair,
    },
    new Set([pair.src, pair.tgt]),
  ];
}

/** Whether the entry marked the root refuted. */
function refutedEffect(entry: ToolResultEvent | FrameworkEvent, gid: string): boolean {
  return (entry.effects ?? []).some((effect) => effect.effect === "refuted" && effect.gid === gid);
}

/** What an eager check recorded. */
interface EagerOutcome {
  check: CheckGoalResult;
}

type Refuted = Pick<Counterexample, "source" | "input" | "unroll" | "divergence">;

/** What a refuting entry kept: the checker, a report's input, and what diverged. */
function refutedBy(entry: ToolResultEvent | FrameworkEvent): Refuted {
  if (entry.kind === "framework") {
    return {
      source: "alive2",
      divergence: (entry.outcome as EagerOutcome | null)?.check.check?.detail,
    };
  }
  const result = entry.result as ReportResult | CheckGoalResult | null;
  if (!result || !("checker" in result)) {
    const unroll = result?.unroll;
    return {
      source: "alive2",
      ...(unroll === undefined ? {} : { unroll }),
      divergence: result?.check?.detail,
    };
  }
  const { checker, input, unroll, divergence } = result;
  return { source: checker, input, ...(unroll === undefined ? {} : { unroll }), divergence };
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
    goals[goal.id] = {
      start,
      steps,
      end,
      discharge: { kind: "check", by: provedBy(goal, effects) },
    };
    return;
  }
  if (interposed(tree, goal)) {
    const lhs = childOf(tree, goal, "lhs");
    const rhs = childOf(tree, goal, "rhs");
    const program = first(lhs, "tgt");
    goals[goal.id] = {
      start,
      steps,
      end,
      discharge: { kind: "interpose", program, lhs: lhs.id, rhs: rhs.id },
    };
    include(tree, lhs, effects, goals, programs);
    include(tree, rhs, effects, goals, programs);
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
      ...(outer.detach ? { detach: outer.detach } : {}),
    },
  };
  include(tree, outer, effects, goals, programs);
  include(tree, inner, effects, goals, programs);
}

/**
 * The moves along a goal's surviving chain, in the order they happened.
 *
 * The log holds every move the run made, the abandoned ones included, and the
 * goal holds the pairs that survived. Replaying the goal's moves as `derive`
 * does, reverts included, says which move made each program it holds.
 */
function chainOf(goal: Goal, effects: Effect[]): Step[] {
  const made = madeBy(goal, effects);
  const steps: Step[] = [];
  const src = goal.src.history;
  const tgt = goal.tgt.history;
  let si = 1;
  let ti = 1;
  for (const effect of effects) {
    if (effect.gid !== goal.id) continue;
    if (effect.effect === "step" && made[effect.side][side(effect, si, ti)] === effect) {
      const from = goal[effect.side].history[side(effect, si, ti) - 1] as Hash;
      // TODO: Support tgt->src rewrites (some kind of anti-optimizations).
      if (effect.how === "rewrite") {
        if (effect.side !== "src") {
          throw new NotCertifiable(
            `a rewrite step on ${goal.id} was recorded on ${effect.side}, but rules optimize forward on src only`,
          );
        }
        if (!effect.rules || effect.rules.length === 0) {
          throw new NotCertifiable(`a rewrite step on ${goal.id} names no rules`);
        }
        if (!effect.invocation) {
          throw new NotCertifiable(`a rewrite step on ${goal.id} records no invocation`);
        }
        steps.push({
          kind: "rewrite",
          side: effect.side,
          from,
          to: effect.to,
          rules: effect.rules,
          invocation: effect.invocation,
        });
      } else if (effect.how === "unfold") {
        steps.push({ kind: "unfold", side: effect.side, from, to: effect.to });
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
                kind: "check",
                side: effect.side,
                from,
                to: effect.to,
                by: effect.by ?? "alive2",
              },
        );
      }
      if (effect.side === "src") si += 1;
      else ti += 1;
    } else if (
      effect.effect === "strengthen" &&
      made.src[si] === effect &&
      made.tgt[ti] === effect
    ) {
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

/** The move that made each program a goal's side holds, by its place in the side's history. */
function madeBy(goal: Goal, effects: Effect[]): Record<"src" | "tgt", (Effect | undefined)[]> {
  const held = { src: [first(goal, "src")], tgt: [first(goal, "tgt")] };
  const made: Record<"src" | "tgt", (Effect | undefined)[]> = {
    src: [undefined],
    tgt: [undefined],
  };
  const push = (side: "src" | "tgt", hash: Hash, effect: Effect) => {
    held[side].push(hash);
    made[side].push(effect);
  };
  for (const effect of effects) {
    if (effect.gid !== goal.id) continue;
    if (effect.effect === "step") push(effect.side, effect.to, effect);
    else if (effect.effect === "strengthen") {
      push("src", effect.src, effect);
      push("tgt", effect.tgt, effect);
    } else if (effect.effect === "revert") {
      // As `derive` reverts: back to the last time the side held that program.
      const kept = held[effect.side].lastIndexOf(effect.to) + 1;
      held[effect.side].length = kept;
      made[effect.side].length = kept;
    }
  }
  return made;
}

/** Who checked a leaf's pair: the last proof of it, since a later step reopens the goal. */
function provedBy(goal: Goal, effects: Effect[]): "alive2" | "reshaped" | "respected" {
  let by: "alive2" | "reshaped" | "respected" = "alive2";
  for (const effect of effects)
    if (effect.effect === "proved" && effect.gid === goal.id) by = effect.by ?? "alive2";
  return by;
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

function childOf(tree: Tree, parent: Goal, role: Role): Goal {
  for (const id of parent.children) {
    const child = tree.goals.get(id);
    if (child?.role === role) return child;
  }
  throw new NotCertifiable(`${parent.id} has no ${role} child`);
}

/** Every effect the log recorded, in order, the framework's as well as the tools'. */
function effectsOf(entries: Entry[]): Effect[] {
  const effects: Effect[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool_result" && entry.kind !== "framework") continue;
    for (const effect of entry.effects ?? []) {
      effects.push(effect);
    }
  }
  return effects;
}

function toolchainOf(entries: Entry[]): unknown {
  const start = entries.find((entry) => entry.kind === "start");
  return start && "toolchain" in start ? start.toolchain : undefined;
}
