// Certifying a counterexample by execution.
//
// alive2 refuting a pair is a hint. The pair may be one the search made rather
// than the one the run was asked about, and the entry state its counterexample
// speaks of may be unreachable from any whole-program input. So nothing here
// reads a refutation: a run is refuted by a concrete input on which the
// original tgt does something the original src does not allow, run under an
// interpreter that models UB and poison.
//
// Finding that input is the agent's problem and is untrusted. This takes one
// and answers what happened, which is the only thing that can mark the root
// refuted.
import type { HarnessArg, Llops } from "../drivers/llops.ts";
import type { RunResult } from "../drivers/llubi.ts";
import type { Goal, Side, Tree } from "./goals.ts";
import type { Store } from "./store.ts";
import type { Effect } from "./trajectory.ts";

/** What this layer needs of llubi, so a test can stand in for it. */
export interface Interpreter {
  run(module: string, options?: { maxSteps?: number }): Promise<RunResult>;
}

/** The two runs a report rests on, kept whole for the trajectory. */
export interface Replay {
  /** The function both sides define, which the harness wraps. */
  entry: string;
  src: RunResult;
  tgt: RunResult;
}

export type ReportResult =
  | {
      kind: "refuted";
      effects: Effect[];
      input: HarnessArg[];
      replay: Replay;
      /** What diverged, in the words the checker will use again. */
      divergence: string;
    }
  | { kind: "refused"; reason: string; input: HarnessArg[]; replay?: Replay };

/** Whether the two runs show the tgt doing what the src does not allow. */
export interface Divergence {
  confirmed: boolean;
  reason: string;
}

/**
 * What the two runs came to.
 *
 * A src that has UB on this input allows every target, so it settles nothing.
 * A tgt that has UB where the src returned is a refutation, and so is any
 * observation the two disagree on. Poison needs no case of its own: the
 * harness stores what the entry returns, storing poison is UB, so a poison
 * result arrives here as UB on the side that produced it.
 */
export function divergence(src: RunResult, tgt: RunResult): Divergence {
  for (const [side, run] of [
    ["src", src],
    ["tgt", tgt],
  ] as const) {
    if (run.outcome === "error") {
      return { confirmed: false, reason: `the ${side} did not run: ${run.reason}` };
    }
  }
  if (src.outcome === "ub") {
    return {
      confirmed: false,
      reason: `the src has UB on this input (${src.reason}), so every target refines it`,
    };
  }
  if (tgt.outcome === "ub") {
    return {
      confirmed: true,
      reason: returnedPoison(tgt)
        ? "the tgt returns poison where the src returns a value"
        : `the tgt has UB where the src returns: ${tgt.reason}`,
    };
  }

  const names = Object.keys(src.observations);
  if (names.length !== Object.keys(tgt.observations).length) {
    return { confirmed: false, reason: "the two runs do not observe the same things" };
  }
  for (const name of names) {
    const theirs = tgt.observations[name];
    if (theirs === undefined) {
      return { confirmed: false, reason: `the tgt run does not observe ${name}` };
    }
    const ours = src.observations[name] as string;
    if (ours !== theirs) {
      return { confirmed: true, reason: `${name} is ${ours} in the src and ${theirs} in the tgt` };
    }
  }
  return { confirmed: false, reason: "the two runs agree" };
}

export class Counterexamples {
  constructor(
    private readonly store: Store,
    private readonly llops: Llops,
    private readonly interp: Interpreter,
  ) {}

  /**
   * Run the pair the run was asked about on one input, and refute the root if
   * they diverge.
   *
   * The pair is the root's first, not its current one: a step is free to
   * overshoot, so a counterexample against a rewritten pair blames the path,
   * and only the original pair is the translation.
   */
  async report(tree: Tree, input: HarnessArg[]): Promise<ReportResult> {
    const root = tree.goals.get(tree.root);
    if (!root) throw new Error(`no goal ${tree.root}`);
    if (root.status === "proved") {
      return {
        kind: "refused",
        reason: `${root.id} is proved, so a divergence would be a contradiction rather than a verdict`,
        input,
      };
    }

    const src = this.store.get(origin(root, "src"));
    const tgt = this.store.get(origin(root, "tgt"));
    const entry = entryOf(src);
    if (entryOf(tgt) !== entry) {
      return { kind: "refused", reason: `the two sides define different functions`, input };
    }
    const choice = choosing(src);
    if (choice) {
      return {
        kind: "refused",
        reason: `the src is free to choose (${choice}), so one run of it does not say what it allows`,
        input,
      };
    }

    const runs: Partial<Record<Side, RunResult>> = {};
    for (const [side, text] of [
      ["src", src],
      ["tgt", tgt],
    ] as const) {
      const harness = await this.llops.harness(text, entry, input);
      if (!harness.ok) {
        return { kind: "refused", reason: `the ${side} harness: ${harness.message}`, input };
      }
      runs[side] = await this.interp.run(harness.module);
    }

    const replay = { entry, src: runs.src as RunResult, tgt: runs.tgt as RunResult };
    const found = divergence(replay.src, replay.tgt);
    if (!found.confirmed) return { kind: "refused", reason: found.reason, input, replay };
    return {
      kind: "refuted",
      effects: [{ effect: "refuted", gid: root.id }],
      input,
      replay,
      divergence: found.reason,
    };
  }
}

/**
 * Whether a run stopped in the harness rather than in the program.
 *
 * `llops harness` stores what the entry returned so that it can be observed,
 * and storing poison is UB, so that store is the only UB the harness itself
 * can have. Stopping there says the program had no UB: it returned poison,
 * which is a different thing to report and a different thing to fix.
 */
export function returnedPoison(run: RunResult): boolean {
  return run.outcome === "ub" && (run.at?.endsWith("at @main") ?? false);
}

/**
 * What lets a program behave more than one way on a fixed input, if anything.
 *
 * The comparison below reads one run of the src as everything the src allows,
 * which holds only where the input settles what it does. In a straightline
 * program the two constructs that do not are `undef`, which takes a fresh
 * value at every use, and `freeze`, which takes an arbitrary one. The tgt is
 * under no such condition: whatever it was seen to do is something it does.
 */
export function choosing(module: string): string | undefined {
  return module.match(/\b(undef|freeze)\b/)?.[1];
}

/** The one function a program defines, which is what a harness wraps. */
export function entryOf(module: string): string {
  const found = module.match(/^define\b[^@]*@([\w.$]+)\s*\(/m);
  if (!found?.[1]) throw new Error("the program defines no function");
  return found[1];
}

/** The program a side started with, which is what the run was asked about. */
function origin(goal: Goal, side: Side): string {
  const first = goal[side].history[0];
  if (first === undefined) throw new Error(`${goal.id} has no ${side} program`);
  return first;
}
