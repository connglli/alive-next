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
import type {
  AnalyzeKind,
  AnalyzeResult,
  EditOp,
  HarnessArg,
  Llops,
  LlopsResult,
  OptOp,
} from "./drivers/llops.ts";
import type { Ref } from "./refs.ts";
import { type ArgumentAssumption, DEFAULT_ASSUMPTION } from "./state/arguments.ts";
import { Counterexamples, type Interpreter, type ReportResult } from "./state/counterexamples.ts";
import {
  derive,
  type Goal,
  head,
  type ProgramId,
  type Side,
  type Status,
  type Tree,
  verdict,
  workable,
} from "./state/goals.ts";
import type { Window } from "./state/narrow.ts";
import { type SplitPreviewResult, type SplitResult, Splits } from "./state/splits.ts";
import {
  type Checker,
  type CheckGoalResult,
  DEFAULT_TIMEOUTS,
  type StepResult,
  Steps,
  type Timeouts,
} from "./state/steps.ts";
import { canonWith, Store } from "./state/store.ts";
import { type Facts, Strengthen, type StrengthenResult } from "./state/strengthen.ts";
import { type Effect, type Entry, type Event, type Hash, Trajectory } from "./state/trajectory.ts";
import { type EditResult, type Transaction, Transactions } from "./state/transactions.ts";

/** One side of a goal, as a reader needs it: what it is called and what it says. */
export interface SideView {
  /** The agent-facing name of the program at the head, as `p7`. */
  id: ProgramId;
  hash: Hash;
  text: string;
  /** Every program this side has been, oldest first, the last being the head. */
  history: ProgramId[];
}

/** A program, by whichever of its two names the caller had. */
export interface ProgramView {
  id: ProgramId;
  hash: Hash;
  text: string;
}

/** A head moved back to a program its side has been. */
export type RevertResult =
  | { kind: "reverted"; effects: Effect[]; to: ProgramView }
  | { kind: "refused"; message: string };

/** A goal as a reader needs it before deciding what to do to it. */
export interface GoalView {
  gid: string;
  status: Status;
  /** Which half of its parent's cut this is. */
  role?: "outer" | "callee";
  /** The outlined function the cut that made it named. */
  callee?: string;
  parent?: string;
  children: string[];
  src: SideView;
  tgt: SideView;
}

/** A goal in the tree, without the programs. */
export interface GoalStanding {
  gid: string;
  status: Status;
  role?: "outer" | "callee";
  parent?: string;
  children: string[];
  src: Hash;
  tgt: Hash;
}

/** Where the run stands: every goal, and the transaction if one is open. */
export interface Standing {
  root: string;
  verdict: "verified" | "counterexample" | "unknown";
  goals: GoalStanding[];
  editing?: { gid: string; side: Side; from: Hash; ops: number };
  /**
   * The budgets this run resolved to. What a check may spend decides what is
   * worth attempting, so it is read here rather than inferred from a result
   * that already cost the time.
   */
  budgets: Timeouts;
  /** What the run assumes about the pair's arguments, which it never proves. */
  assumed: ArgumentAssumption;
}

/** What a session needs to exist: where it lives and what it can spawn. */
export interface SessionOptions {
  dir: string;
  llops: Llops;
  checker: Checker;
  /** llubi, which is what certifies a counterexample. */
  interp: Interpreter;
  timeouts?: Timeouts;
}

/** What `start` records about the run, verbatim, in `run_start`. */
export interface SessionStartOptions extends SessionOptions {
  src: string;
  tgt: string;
  /**
   * What the pair's arguments may be, which is part of the question and is
   * never proved. Defaults to arguments that are defined but may be poison.
   * A resumed run reads it back from the log rather than being told again.
   */
  assumed?: ArgumentAssumption;
  /** The resolved configuration, so a trajectory says what produced it. */
  config?: unknown;
  /** What the toolchain reported when the caller insisted on it. */
  toolchain?: unknown;
  /** Version lines for everything the toolchain does not cover. */
  versions?: Record<string, string>;
}

export class Session {
  readonly store: Store;
  private readonly llops: Llops;
  private readonly log: Trajectory;
  private readonly steps: Steps;
  private readonly splits: Splits;
  private readonly strengthening: Strengthen;
  private readonly editing: Transactions;
  private readonly counterexamples: Counterexamples;
  private entries: Entry[] = [];
  private derived?: Tree;
  private calls = 0;

  private constructor(
    readonly dir: string,
    options: SessionOptions,
  ) {
    mkdirSync(dir, { recursive: true });
    this.llops = options.llops;
    this.store = new Store(join(dir, "store"), canonWith(options.llops));
    this.log = new Trajectory(join(dir, "trajectory.jsonl"));
    this.steps = new Steps(
      this.store,
      options.checker,
      options.timeouts ?? DEFAULT_TIMEOUTS,
      options.llops,
    );
    this.splits = new Splits(this.store, options.llops);
    this.strengthening = new Strengthen(this.store, options.llops, this.steps);
    this.editing = new Transactions(this.store, options.llops);
    this.counterexamples = new Counterexamples(this.store, options.llops, options.interp);
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
      assumed: options.assumed ?? DEFAULT_ASSUMPTION,
      config: resolved(options.config, session.steps.budgets),
      toolchain: options.toolchain,
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

  /**
   * Where the run stands: every goal with its status and its heads, and the
   * transaction if one is open. This is the first thing to read and the
   * cheapest, since it names no program.
   */
  status(): Promise<Standing> {
    return this.act("status", {}, async (tree) => {
      const open = this.editing.open();
      const standing: Standing = {
        root: tree.root,
        verdict: verdict(tree),
        goals: standings(tree),
        budgets: this.steps.budgets,
        assumed: tree.assumed,
      };
      if (open) {
        standing.editing = {
          gid: open.gid,
          side: open.side,
          from: open.from,
          ops: open.ops.length,
        };
      }
      return standing;
    });
  }

  /**
   * One goal, both sides, as text. This is what to read before deciding what
   * to do to it, since a program's value references are the program's own.
   *
   * The log keeps the two hashes rather than the two programs, because the
   * store already holds the text under exactly those names.
   */
  show(gid: string): Promise<GoalView> {
    return this.act(
      "show",
      { gid },
      async (tree) => {
        const goal = goalOf(tree, gid);
        const view: GoalView = {
          gid: goal.id,
          status: goal.status,
          children: [...goal.children],
          src: this.side(tree, goal, "src"),
          tgt: this.side(tree, goal, "tgt"),
        };
        if (goal.role) view.role = goal.role;
        if (goal.callee) view.callee = goal.callee;
        if (goal.parent) view.parent = goal.parent;
        return view;
      },
      (view) => ({ gid: view.gid, status: view.status, src: view.src.hash, tgt: view.tgt.hash }),
    );
  }

  /**
   * Any program the run has held, by its name or its hash. A side's history
   * says which programs those are, so this is how an earlier one is read
   * before deciding whether to go back to it.
   */
  program(ref: string): Promise<ProgramView> {
    return this.act(
      "program",
      { ref },
      async (tree) => this.programOf(tree, ref),
      (view) => ({ id: view.id, hash: view.hash }),
    );
  }

  /**
   * Move a side's head back to a program it has been. Later steps stay in the
   * log, unused, and whatever the proof they carried had settled comes undone
   * with them.
   */
  revert(gid: string, side: Side, to: string): Promise<RevertResult> {
    return this.act("revert", { gid, side, to }, async (tree) => {
      if (this.editing.isEditing(gid, side)) {
        return { kind: "refused", message: `a transaction is open on ${gid} ${side}` };
      }
      const goal = workable(tree, gid);
      const target = this.programOf(tree, to);
      if (!goal[side].history.includes(target.hash)) {
        return { kind: "refused", message: `${gid} ${side} has never been ${target.id}` };
      }
      if (head(goal, side) === target.hash) {
        return { kind: "refused", message: `${gid} ${side} is already ${target.id}` };
      }
      return {
        kind: "reverted",
        effects: [{ effect: "revert", gid, side, to: target.hash }],
        to: target,
      };
    });
  }

  /**
   * Ask an analysis about one side of a goal. It changes nothing, and what it
   * answers is a proposal: a fact counts once a step alive2 certified put it
   * in the program.
   */
  analyze(
    gid: string,
    side: Side,
    kind: AnalyzeKind,
    point?: Ref,
  ): Promise<LlopsResult<AnalyzeResult>> {
    return this.act("analyze", { gid, side, kind, point }, (tree) =>
      this.llops.analyze(this.store.get(head(goalOf(tree, gid), side)), kind, point),
    );
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

  /** Apply one edit to the open transaction, which is how every rewrite continues. */
  edit(op: EditOp): Promise<EditResult> {
    return this.act("edit", op, () => this.editing.edit(op), scratch);
  }

  /** Certify the open transaction as one step. */
  commit(
    options?: {
      window?: Window;
      preconditions?: Record<string, Record<string, unknown>>;
    },
    imm_abort: boolean = true,
  ): Promise<StepResult> {
    return this.act("commit", { ...options, imm_abort }, (tree) =>
      this.editing.commit(tree, this.steps, options, imm_abort),
    );
  }

  /** Abandon the open transaction, which leaves the goal unchanged. */
  abort(): Promise<Transaction> {
    return this.act("abort", {}, async () => this.editing.abort(), scratch);
  }

  /** Fold one instruction of the scratch with llops' own simplifier. */
  opt(op: OptOp): Promise<EditResult> {
    return this.act("opt", op, () => this.editing.opt(op), scratch);
  }

  /**
   * Preview cutting a goal in two without modifying the goal tree or store.
   * If valueMap is omitted, returns the src live-in parameter signature.
   * If valueMap is provided, validates that the tgt cut lines up with that signature.
   */
  splitPreview(
    gid: string,
    srcCut: Ref,
    tgtCut: Ref,
    valueMap?: Record<Ref, Ref>,
  ): Promise<SplitPreviewResult> {
    return this.act(
      "split_preview",
      { gid, src_cut: srcCut, tgt_cut: tgtCut, value_map: valueMap },
      (tree) => this.splits.preview(tree, gid, srcCut, tgtCut, valueMap),
    );
  }

  /** Cut a goal in two, which adds the two children to the tree. */
  split(gid: string, srcCut: Ref, tgtCut: Ref, valueMap: Record<Ref, Ref>): Promise<SplitResult> {
    return this.act(
      "split",
      { gid, src_cut: srcCut, tgt_cut: tgtCut, value_map: valueMap },
      (tree) => this.splits.split(tree, gid, srcCut, tgtCut, valueMap),
    );
  }

  /** Undo a split, which discards the two children and their subtrees. */
  unsplit(gid: string): Promise<{ effects: Effect[] }> {
    return this.act("unsplit", { gid }, async (tree) => ({
      effects: this.splits.unsplit(tree, gid),
    }));
  }

  /** State facts about a cut's parameters, one interface at a time. */
  strengthen(gid: string, facts: Facts): Promise<StrengthenResult> {
    return this.act("strengthen", { gid, facts }, (tree) =>
      this.strengthening.strengthen(tree, gid, facts),
    );
  }

  /**
   * Offer a whole-program input as a counterexample. The framework runs the
   * pair the run was asked about under the interpreter, and a divergence it
   * sees for itself is what refutes the root.
   */
  reportCex(input: HarnessArg[]): Promise<ReportResult> {
    return this.act("report_cex", { input }, (tree) => this.counterexamples.report(tree, input));
  }

  /**
   * The caller saying it has nothing left to try. It changes no goal, so the
   * verdict stays whatever the tree says, which is "unknown"; what it adds is
   * a line saying the run ended on purpose rather than on a budget or a crash.
   */
  giveUp(reason: string): Promise<{ reason: string }> {
    return this.act("give_up", { reason }, async () => ({ reason }));
  }

  /** An agent turn, recorded verbatim so the log holds what the model saw. */
  message(message: unknown): void {
    this.append({ kind: "message", message });
  }

  /**
   * Something the framework did that no tool call names: a budget spent, a
   * compaction, a check it ran on its own. It changes no goal, so it carries
   * no effects, but a trajectory that leaves it out does not say what
   * happened.
   */
  note(action: string, outcome: unknown): void {
    this.append({ kind: "auto", action, outcome });
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

  private side(tree: Tree, goal: Goal, side: Side): SideView {
    const hash = head(goal, side);
    return {
      id: nameOf(tree, hash),
      hash,
      text: this.store.get(hash),
      history: goal[side].history.map((was) => nameOf(tree, was)),
    };
  }

  /** A program by its agent-facing name or by its hash, whichever was given. */
  private programOf(tree: Tree, ref: string): ProgramView {
    for (const [hash, id] of tree.programs) {
      if (ref === id || ref === hash) return { id, hash, text: this.store.get(hash) };
    }
    throw new Error(`no program ${ref}`);
  }
}

/** The name a program goes by, which the tree hands out as it first sees one. */
function nameOf(tree: Tree, hash: Hash): ProgramId {
  const id = tree.programs.get(hash);
  if (!id) throw new Error(`the tree has no name for ${hash}`);
  return id;
}

function goalOf(tree: Tree, gid: string): Goal {
  const goal = tree.goals.get(gid);
  if (!goal) throw new Error(`no goal ${gid}`);
  return goal;
}

/** Every goal without its programs, which is the tree as a reader sees it. */
export function standings(tree: Tree): GoalStanding[] {
  return [...tree.goals.values()].map(standingOf);
}

function standingOf(goal: Goal): GoalStanding {
  const standing: GoalStanding = {
    gid: goal.id,
    status: goal.status,
    children: [...goal.children],
    src: head(goal, "src"),
    tgt: head(goal, "tgt"),
  };
  if (goal.role) standing.role = goal.role;
  if (goal.parent) standing.parent = goal.parent;
  return standing;
}

/**
 * The configuration a run records: what the caller was given, with the budgets
 * it resolved to. A file that names no timeout still produced the ones a run
 * spent, and the snapshot is where a reader of the trajectory finds them.
 */
function resolved(config: unknown, timeouts: Timeouts): unknown {
  return typeof config === "object" && config !== null ? { ...config, timeouts } : { timeouts };
}

/** A transaction result as the log keeps it: what it did, not what it holds. */
function scratch(result: Transaction | EditResult): unknown {
  if (!("kind" in result)) {
    return { gid: result.gid, side: result.side, from: result.from, ops: result.ops.length };
  }
  if (result.kind === "applied") return { kind: "applied", ops: result.ops };
  if (result.kind === "unchanged") return { kind: "unchanged", ops: result.ops };
  return { kind: "refused", code: result.code, message: result.message };
}
