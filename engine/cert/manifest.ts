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
import type { HarnessArg } from "../core/drivers/llops.ts";
import type { ArgumentAssumption } from "../core/state/arguments.ts";
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
      /** Options the run passed alive-tv beyond its timeout. */
      flags: string[];
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
      flags: string[];
      window: {
        callee: string;
        outer: Hash;
        from: Hash;
        to: Hash;
        preconditions?: Record<string, Record<string, unknown>>;
      };
    }
  /**
   * Both sides took an attribute the caller was shown to honour. No check
   * certifies this on its own: what does is the outer's chain, which is
   * checked like any other, and the signature the two ends have to share.
   */
  | {
      kind: "strengthen";
      from: Pair;
      to: Pair;
      facts: Record<number, Record<string, unknown>>;
      by: { gid: string; hash: Hash };
    };

export interface Pair {
  src: Hash;
  tgt: Hash;
}

/** How a goal was discharged. */
export type Discharge =
  | { kind: "checked" }
  | { kind: "split"; callee: string; outer: string; inner: string };

export interface ManifestGoal {
  /** The pair the goal started with, which is what it proves about. */
  start: Pair;
  steps: Step[];
  /** The pair it ended with, which every step above adds up to. */
  end: Pair;
  discharge: Discharge;
}

export interface Proof {
  version: number;
  verdict: "verified";
  root: string;
  /** The binaries the run used, as `run_start` recorded them. */
  toolchain: unknown;
  /**
   * What the run assumed about the pair's arguments. A proof means what it
   * means only under this, so a checker states it beside the verdict and works
   * out for itself which goals it reaches, rather than believing the flags a
   * step claims to have run with.
   */
  assumed: ArgumentAssumption;
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
  const moves = movesOf(entries);
  const goals: Record<string, ManifestGoal> = {};
  const programs = new Set<Hash>();
  include(tree, root, moves, goals, programs);
  return [
    {
      version: VERSION,
      verdict: "verified" as const,
      root: tree.root,
      toolchain: toolchainOf(entries),
      assumed: tree.assumed,
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
  moves: Move[],
  goals: Record<string, ManifestGoal>,
  programs: Set<Hash>,
): void {
  const start = { src: first(goal, "src"), tgt: first(goal, "tgt") };
  const end = { src: head(goal, "src"), tgt: head(goal, "tgt") };
  const steps = chainOf(goal, moves);
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
  include(tree, outer, moves, goals, programs);
  include(tree, inner, moves, goals, programs);
}

/**
 * The moves along a goal's surviving chain, in the order they happened.
 *
 * The log holds every move the run made, the abandoned ones included, and the
 * goal holds the pairs that survived. Walking the log and taking each move
 * that lands on the next surviving pair is what leaves the path.
 */
function chainOf(goal: Goal, moves: Move[]): Step[] {
  const steps: Step[] = [];
  const src = goal.src.history;
  const tgt = goal.tgt.history;
  let si = 1;
  let ti = 1;
  for (const move of moves) {
    const effect = move.effect;
    if (effect.gid !== goal.id) continue;
    if (effect.effect === "step" && effect.to === goal[effect.side].history[side(effect, si, ti)]) {
      const from = goal[effect.side].history[side(effect, si, ti) - 1] as Hash;
      steps.push(
        effect.window
          ? {
              kind: "window",
              side: effect.side,
              from,
              to: effect.to,
              flags: [],
              window: effect.window,
            }
          : {
              kind: "checked",
              side: effect.side,
              from,
              to: effect.to,
              flags: move.flags ?? [],
            },
      );
      if (effect.side === "src") si += 1;
      else ti += 1;
    } else if (effect.effect === "strengthen" && effect.src === src[si] && effect.tgt === tgt[ti]) {
      steps.push({
        kind: "strengthen",
        from: { src: src[si - 1] as Hash, tgt: tgt[ti - 1] as Hash },
        to: { src: effect.src, tgt: effect.tgt },
        facts: effect.facts,
        by: effect.by,
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

/** A move the log recorded, with the options that certified it. */
interface Move {
  effect: Effect;
  flags?: string[];
}

/**
 * Every move the log holds, in order.
 *
 * A result carries its checks in the order its effects landed, so the steps
 * and the checks line up by counting, and the timeout is left behind: what a
 * replay allows the solver is its own business.
 */
function movesOf(entries: Entry[]): Move[] {
  const moves: Move[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool_result") continue;
    const result = entry.result as { check?: Checked; checks?: Checked[] } | null;
    const checks = result?.checks ?? (result?.check ? [result.check] : []);
    let index = 0;
    for (const effect of entry.effects ?? []) {
      if (effect.effect === "step") {
        const flags = checks[index]?.invocation?.flags ?? [];
        moves.push({ effect, flags: flags.filter((flag) => !flag.startsWith("--smt-to")) });
        index += 1;
      } else {
        moves.push({ effect });
      }
    }
  }
  return moves;
}

interface Checked {
  invocation?: { flags?: string[] };
}

function toolchainOf(entries: Entry[]): unknown {
  const start = entries.find((entry) => entry.kind === "run_start");
  return start && "toolchain" in start ? start.toolchain : undefined;
}
