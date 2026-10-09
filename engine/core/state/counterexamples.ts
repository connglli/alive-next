// Certifying a counterexample.
//
// A run is refuted when alive2 finds the original tgt doing something the
// original src does not allow, either on the root's original pair as it
// stands or on that pair at an input, which `llops instantiate` assumes at
// both entries. Where alive2 does not decide an input, llubi runs both
// programs on it instead, which is weaker evidence, since llubi's semantics
// are not alive2's. A counterexample for another pair is dropped, since the
// search can produce pairs whose entry state no input reaches.
//
// Finding that input is the agent's problem and is untrusted. This takes one
// and answers what happened.
import type { CheckResult } from "../drivers/alive2.ts";
import type { InputArg, Llops } from "../drivers/llops.ts";
import type { RunResult } from "../drivers/llubi.ts";
import type { Goal, Side, Tree } from "./goals.ts";
import type { Steps } from "./steps.ts";
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

/** What a report asked: the input, and how far alive2 unrolls each loop. */
interface Asked {
  input: InputArg[];
  unroll?: number;
}

export type ReportResult =
  | (Asked & {
      kind: "refuted";
      effects: Effect[];
      /** alive2, or llubi where alive2 did not decide. */
      checker: "alive2" | "llubi";
      /** What diverged, in the words the checker will use again. */
      divergence: string;
      check: CheckResult;
      replay?: Replay;
    })
  | (Asked & { kind: "refused"; reason: string; check?: CheckResult; replay?: Replay });

/** Whether the two runs show the tgt doing what the src does not allow. */
export interface Divergence {
  confirmed: boolean;
  reason: string;
}

/**
 * What the two runs came to.
 *
 * A src that has UB on this input allows every target, so it settles nothing,
 * and a src observation that is poison allows any value there. A tgt that has
 * UB where the src returned is a refutation, and so is any other observation
 * the two disagree on, poison in the tgt included.
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
      reason: `the src has UB on this input (${src.reason}), so every tgt refines it`,
    };
  }
  if (tgt.outcome === "ub") {
    return { confirmed: true, reason: `the tgt has UB where the src returns: ${tgt.reason}` };
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
    if (ours === theirs || ours.includes("poison")) continue;
    return { confirmed: true, reason: `${name} is ${ours} in the src and ${theirs} in the tgt` };
  }
  return { confirmed: false, reason: "the two runs agree" };
}

export class Counterexamples {
  constructor(
    private readonly store: Store,
    private readonly llops: Llops,
    private readonly steps: Steps,
    private readonly interp: Interpreter,
  ) {}

  /**
   * Ask alive2 about the pair the run was asked about at one input, each loop
   * unrolled `unroll` times, and refute the root if it finds a divergence.
   * Where alive2 does not decide, llubi runs the pair on the input instead.
   *
   * The pair is the root's first, not its current one: a step is free to
   * overshoot, so a counterexample against a rewritten pair is a hint, since
   * only the original pair is the translation.
   */
  async report(
    tree: Tree,
    input: InputArg[],
    unroll?: number,
    timeoutMs?: number,
  ): Promise<ReportResult> {
    const root = tree.goals.get(tree.root);
    if (!root) throw new Error(`no goal ${tree.root}`);
    const asked: Asked = { input, ...(unroll === undefined ? {} : { unroll }) };
    if (root.status === "proved") {
      const reason = `${root.id} is already proved, so no input can refute it`;
      return { kind: "refused", reason, ...asked };
    }

    const src = this.store.get(origin(root, "src"));
    const tgt = this.store.get(origin(root, "tgt"));
    const pair = await this.llops.instantiate(src, tgt, input);
    if (!pair.ok) return { kind: "refused", reason: `the input: ${pair.message}`, ...asked };
    const check = await this.steps.refinementCheck(pair.src, pair.tgt, timeoutMs, unroll);
    if (check.outcome === "incorrect") {
      const divergence = check.detail.split("\n")[0] ?? "";
      return {
        kind: "refuted",
        effects: refuted(root),
        ...asked,
        checker: "alive2",
        divergence,
        check,
      };
    }
    // alive2's answer stands, unless it covers only the iterations it unrolled.
    if (check.outcome === "correct" && !(await this.loops(src, tgt))) {
      return {
        kind: "refused",
        reason: "alive2 finds no divergence on this input",
        ...asked,
        check,
      };
    }
    // Fallback to llubi.
    return this.replay(root, src, tgt, asked, check);
  }

  /** Run the pair on the input under llubi, since alive2 did not decide it. */
  private async replay(
    root: Goal,
    src: string,
    tgt: string,
    asked: Asked,
    check: CheckResult,
  ): Promise<ReportResult> {
    const entry = await this.entry(src);
    if ((await this.entry(tgt)) !== entry) {
      return {
        kind: "refused",
        reason: "the two sides define different functions",
        ...asked,
        check,
      };
    }
    const runs: Partial<Record<Side, RunResult>> = {};
    for (const [side, text] of [
      ["src", src],
      ["tgt", tgt],
    ] as const) {
      const harness = await this.llops.harness(text, entry, asked.input);
      if (!harness.ok) {
        return {
          kind: "refused",
          reason: `the ${side} harness: ${harness.message}`,
          ...asked,
          check,
        };
      }
      // llubi's run stands for the src only where llubi treats it as alive2 does.
      if (side === "src" && harness.differences.length > 0) {
        const different = harness.differences.join(", ");
        const reason = `alive2 did not decide this input, and llubi treats the src's ${different} differently from alive2`;
        return { kind: "refused", reason, ...asked, check };
      }
      runs[side] = await this.interp.run(harness.module);
    }

    const replay = { entry, src: runs.src as RunResult, tgt: runs.tgt as RunResult };
    const found = divergence(replay.src, replay.tgt);
    if (!found.confirmed) {
      const reason = `alive2 did not decide this input, and under llubi ${found.reason}`;
      return { kind: "refused", reason, ...asked, check, replay };
    }
    return {
      kind: "refuted",
      effects: refuted(root),
      ...asked,
      checker: "llubi",
      divergence: found.reason,
      check,
      replay,
    };
  }

  /** Whether either program loops, as `llops validate` says. */
  private async loops(...modules: string[]): Promise<boolean> {
    for (const module of modules) {
      const result = await this.llops.validate(module);
      if (!result.ok || result.cyclic) return true;
    }
    return false;
  }

  /** The one function a program defines, which is what a harness wraps. */
  private async entry(module: string): Promise<string> {
    const result = await this.llops.validate(module);
    if (!result.ok) throw new Error(`llops validate: ${result.message}`);
    const defined = Object.entries(result.functions ?? {}).filter(([, fn]) => fn.defined);
    const [only] = defined;
    if (!only || defined.length !== 1) throw new Error("the program does not define one function");
    return only[0];
  }
}

/** The effect that marks the root refuted. */
function refuted(root: Goal): Effect[] {
  return [{ effect: "refuted", gid: root.id }];
}

/** The program a side started with, which is what the run was asked about. */
function origin(goal: Goal, side: Side): string {
  const first = goal[side].history[0];
  if (first === undefined) throw new Error(`${goal.id} has no ${side} program`);
  return first;
}
