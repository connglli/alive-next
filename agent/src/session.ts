// A session: one directory on disk, and the moves that carry it to a verdict.
//
// Everything below this file works on a tree it is handed and answers with the
// effects it had. This is where those pieces meet the directory: the store,
// the trajectory the framework holds the pen for, and the goal tree the log
// says exists.
//
// Every move is written down as it happens, a `tool_call` before and a
// `tool_result` after, and the tree is then rebuilt by replaying the log. That
// rebuild is the point. The log is the source of truth by construction rather
// than by discipline, because there is no other copy of the tree to drift from
// it, and a bug in derivation shows up on the next move rather than in a
// certificate a day later.
//
// The agent does not appear here. A scripted caller and a model driving Pi's
// loop make the same moves through the same door, which is what lets the
// end-to-end scenarios run with nothing in front of them.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EditOp, Llops } from "./drivers/llops.ts";
import type { Ref } from "./refs.ts";
import { derive, type Side, type Tree, verdict } from "./state/goals.ts";
import { type SplitResult, Splits } from "./state/splits.ts";
import {
  type Checker,
  type CheckGoalResult,
  DEFAULT_TIMEOUTS,
  type StepResult,
  Steps,
  type Timeouts,
} from "./state/steps.ts";
import { canonWith, Store } from "./state/store.ts";
import { type Fact, Strengthen, type StrengthenResult } from "./state/strengthen.ts";
import { type Effect, type Entry, type Event, Trajectory } from "./state/trajectory.ts";
import { type EditResult, type Transaction, Transactions } from "./state/transactions.ts";

/** What a session needs to exist: where it lives and what it can spawn. */
export interface SessionOptions {
  dir: string;
  llops: Llops;
  checker: Checker;
  timeouts?: Timeouts;
}

/** What `start` records about the run, verbatim, in `run_start`. */
export interface SessionStartOptions extends SessionOptions {
  src: string;
  tgt: string;
  /** The resolved configuration, so a trajectory says what produced it. */
  config?: unknown;
  /** Version lines for the binaries and the model, gathered by the caller. */
  versions?: Record<string, string>;
}

export class Session {
  readonly store: Store;
  private readonly log: Trajectory;
  private readonly steps: Steps;
  private readonly splits: Splits;
  private readonly strengthening: Strengthen;
  private readonly editing: Transactions;
  private entries: Entry[] = [];
  private derived?: Tree;
  private calls = 0;

  private constructor(
    readonly dir: string,
    options: SessionOptions,
  ) {
    mkdirSync(dir, { recursive: true });
    this.store = new Store(join(dir, "store"), canonWith(options.llops));
    this.log = new Trajectory(join(dir, "trajectory.jsonl"));
    this.steps = new Steps(this.store, options.checker, options.timeouts ?? DEFAULT_TIMEOUTS);
    this.splits = new Splits(this.store, options.llops);
    this.strengthening = new Strengthen(this.store, options.llops, this.steps);
    this.editing = new Transactions(this.store, options.llops);
  }

  /** Begin a run on a pair, in a directory that has none. */
  static async start(options: SessionStartOptions): Promise<Session> {
    const session = new Session(options.dir, options);
    if (session.log.read().length > 0) throw new Error(`${options.dir} already holds a run`);
    // The programs are stored before the event that names them, so a crash
    // leaves an unreferenced program rather than an event pointing at nothing.
    const src = await session.store.put(options.src);
    const tgt = await session.store.put(options.tgt);
    session.append({
      kind: "run_start",
      src,
      tgt,
      config: options.config ?? {},
      versions: options.versions ?? {},
    });
    return session;
  }

  /** Pick a run back up from its directory, which replays what it did. */
  static resume(options: SessionOptions): Session {
    const session = new Session(options.dir, options);
    session.entries = session.log.read();
    if (session.entries.length === 0) throw new Error(`${options.dir} holds no run`);
    session.derived = derive(session.entries);
    return session;
  }

  /** The goal tree, as the log says it stands. */
  get tree(): Tree {
    if (!this.derived) throw new Error(`${this.dir} has no run_start`);
    return this.derived;
  }

  get verdict(): "verified" | "counterexample" | "unknown" {
    return verdict(this.tree);
  }

  /** Ask whether a goal's claim holds as it stands. */
  check(gid: string, timeoutMs?: number): Promise<CheckGoalResult> {
    return this.act("check", { gid, timeout_ms: timeoutMs }, (tree) =>
      this.steps.checkGoal(tree, gid, timeoutMs),
    );
  }

  /** Open a transaction on a goal's side, which is how every rewrite starts. */
  begin(gid: string, side: Side): Promise<Transaction> {
    return this.act(
      "begin",
      { gid, side },
      async (tree) => this.editing.begin(tree, gid, side),
      scratch,
    );
  }

  edit(op: EditOp): Promise<EditResult> {
    return this.act("edit", op, () => this.editing.edit(op), scratch);
  }

  /** Certify the open transaction as one step. */
  commit(): Promise<StepResult> {
    return this.act("commit", {}, (tree) => this.editing.commit(tree, this.steps));
  }

  abort(): Promise<Transaction> {
    return this.act("abort", {}, async () => this.editing.abort(), scratch);
  }

  split(gid: string, srcCut: Ref, tgtCut: Ref, valueMap: Record<Ref, Ref>): Promise<SplitResult> {
    return this.act(
      "split",
      { gid, src_cut: srcCut, tgt_cut: tgtCut, value_map: valueMap },
      (tree) => this.splits.split(tree, gid, srcCut, tgtCut, valueMap),
    );
  }

  unsplit(gid: string): Promise<{ effects: Effect[] }> {
    return this.act("unsplit", { gid }, async (tree) => ({
      effects: this.splits.unsplit(tree, gid),
    }));
  }

  strengthen(gid: string, param: number, fact: Fact): Promise<StrengthenResult> {
    return this.act("strengthen", { gid, param, fact }, (tree) =>
      this.strengthening.strengthen(tree, gid, param, fact),
    );
  }

  /** An agent turn, recorded verbatim so the log holds what the model saw. */
  message(message: unknown): void {
    this.append({ kind: "message", message });
  }

  /** Close the run with the verdict its tree has reached. */
  finish(certificate?: string): "verified" | "counterexample" | "unknown" {
    const outcome = this.verdict;
    this.append({ kind: "verdict", outcome, certificate });
    return outcome;
  }

  /**
   * Session one move, with the two lines that record it around it. The result is
   * written down whole by default, counterexample text included, because that
   * is what a reader of the trajectory has to work from. `written` is for the
   * moves that answer with a whole program: the store holds those under a
   * hash, and a log that repeats one per edit is a log nobody reads.
   */
  private async act<T>(
    tool: string,
    args: unknown,
    move: (tree: Tree) => Promise<T>,
    written: (result: T) => unknown = (result) => result,
  ): Promise<T> {
    const id = `t${++this.calls}`;
    this.append({ kind: "tool_call", id, tool, args });
    const started = Date.now();
    const result = await move(this.tree);
    this.append({
      kind: "tool_result",
      id,
      tool,
      // A move that changed the tree says so in an `effects` field, and one
      // that reads or refuses has none, which is what this asks each result.
      effects: (result as { effects?: Effect[] }).effects ?? [],
      result: written(result),
      ms: Date.now() - started,
    });
    return result;
  }

  private append(event: Event): void {
    this.entries.push(this.log.append(event));
    this.derived = derive(this.entries);
  }
}

/** A transaction result as the log keeps it: what it did, not what it holds. */
function scratch(result: Transaction | EditResult): unknown {
  if (!("kind" in result)) {
    return { gid: result.gid, side: result.side, from: result.from, ops: result.ops.length };
  }
  return result.kind === "applied" ? { kind: "applied", ops: result.ops } : result;
}
