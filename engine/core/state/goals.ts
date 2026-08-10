// The goal tree, derived from the trajectory.
//
// A goal is the unit of proof: a pair of programs and the claim that the tgt
// side refines the src side. Goals form a tree, the root being the pair the
// run was asked about, and the verdict is read off the root rather than
// asserted anywhere.
//
// Nothing here is stored. `derive` folds the event log into the tree, so the
// log is the only thing that has to be right, and a reader that replays it
// sees exactly what the run saw. That also makes this file pure: no disk, no
// clock, no processes.
import type { Effect, Entry, Hash } from "./trajectory.ts";

export type GoalId = string;
export type ProgramId = string;
export type Side = "src" | "tgt";

/** open until it is discharged, split once it has children, or settled. */
export type Status = "open" | "proved" | "split" | "refuted";

/** One side of a goal: every program it has been, the last one being current. */
export interface SideHistory {
  history: Hash[];
}

export interface Goal {
  id: GoalId;
  parent?: GoalId;
  /** Which half of its parent's cut this is. */
  role?: "outer" | "callee";
  /** The outlined function this cut made, on both of its children. */
  callee?: string;
  src: SideHistory;
  tgt: SideHistory;
  status: Status;
  children: GoalId[];
}

export interface Tree {
  root: GoalId;
  goals: Map<GoalId, Goal>;
  /** Agent-facing program names, in the order the programs first appeared. */
  programs: Map<Hash, ProgramId>;
  /**
   * The number the next goal will take. It counts goals ever made rather than
   * goals alive, so an unsplit does not hand its children's names to the next
   * cut and a trajectory names one goal one thing.
   */
  nextGoal: number;
}

/** Thrown when the log says something the tree cannot mean. */
export class DerivationError extends Error {
  constructor(message: string) {
    super(`goal tree: ${message}`);
    this.name = "DerivationError";
  }
}

/** The current program of a side, which every tool operates on. */
export function head(goal: Goal, side: Side): Hash {
  const history = goal[side].history;
  const last = history[history.length - 1];
  if (last === undefined) throw new DerivationError(`${goal.id} has no ${side} program`);
  return last;
}

/** Goals with no children that are still open, which is where work remains. */
export function openLeaves(tree: Tree): Goal[] {
  return [...tree.goals.values()].filter(
    (goal) => goal.status === "open" && goal.children.length === 0,
  );
}

/**
 * The verdict, read off the root. Anything but a proved or refuted root is
 * unknown, including a run that stopped with work left.
 */
export function verdict(tree: Tree): "verified" | "counterexample" | "unknown" {
  const root = tree.goals.get(tree.root);
  if (root?.status === "proved") return "verified";
  if (root?.status === "refuted") return "counterexample";
  return "unknown";
}

/**
 * The goal a move may touch, which is one that has not been cut or refuted.
 *
 * A proved goal qualifies. Touching it reopens it when the effect is recorded,
 * because the proof was about the pair the move replaces, and every move that
 * can settle a goal early would otherwise be a move that can freeze it.
 */
export function workable(tree: Tree, id: GoalId): Goal {
  const goal = get(tree, id);
  if (goal.status === "split" || goal.status === "refuted") {
    throw new DerivationError(`${id} is ${goal.status}, not open`);
  }
  return goal;
}

/** Apply one effect to a tree, which is what derive does line by line. */
export function applyEffect(tree: Tree, effect: Effect): void {
  apply(tree, effect);
}

/** Replay the log into the tree it describes. */
export function derive(entries: Entry[]): Tree {
  let tree: Tree | undefined;
  for (const entry of entries) {
    if (entry.kind === "run_start") {
      if (tree) throw new DerivationError("a second run_start");
      tree = start(entry.src, entry.tgt);
      continue;
    }
    const effects = "effects" in entry ? (entry.effects ?? []) : [];
    for (const effect of effects) {
      if (!tree) throw new DerivationError(`${effect.effect} before run_start`);
      apply(tree, effect);
    }
  }
  if (!tree) throw new DerivationError("no run_start");
  return tree;
}

function start(src: Hash, tgt: Hash): Tree {
  const root: Goal = {
    id: "g1",
    src: { history: [src] },
    tgt: { history: [tgt] },
    status: "open",
    children: [],
  };
  const tree: Tree = {
    root: root.id,
    goals: new Map([[root.id, root]]),
    programs: new Map(),
    nextGoal: 2,
  };
  name(tree, src);
  name(tree, tgt);
  return tree;
}

function apply(tree: Tree, effect: Effect): void {
  switch (effect.effect) {
    case "step": {
      const goal = editable(tree, effect.gid);
      goal[effect.side].history.push(effect.to);
      name(tree, effect.to);
      return;
    }

    case "revert": {
      const goal = editable(tree, effect.gid);
      const at = goal[effect.side].history.lastIndexOf(effect.to);
      if (at < 0) {
        throw new DerivationError(`${effect.gid} never had ${effect.to} on its ${effect.side}`);
      }
      // The abandoned steps stay in the log; the head is what moves back.
      goal[effect.side].history = goal[effect.side].history.slice(0, at + 1);
      return;
    }
    case "split": {
      const parent = editable(tree, effect.gid);
      for (const [role, child] of [
        ["outer", effect.outer],
        ["callee", effect.callee],
      ] as const) {
        if (tree.goals.has(child.gid)) throw new DerivationError(`${child.gid} already exists`);
        tree.goals.set(child.gid, {
          id: child.gid,
          parent: parent.id,
          role,
          callee: effect.name,
          src: { history: [child.src] },
          tgt: { history: [child.tgt] },
          status: "open",
          children: [],
        });
        parent.children.push(child.gid);
        tree.nextGoal = Math.max(tree.nextGoal, number(child.gid) + 1);
        name(tree, child.src);
        name(tree, child.tgt);
      }
      // The parent's heads freeze here: it is proved through its children now.
      parent.status = "split";
      return;
    }
    case "strengthen": {
      // Both sides move together, because the attribute is one claim about
      // the goal rather than a step on either side of it.
      const goal = editable(tree, effect.gid);
      goal.src.history.push(effect.src);
      goal.tgt.history.push(effect.tgt);
      name(tree, effect.src);
      name(tree, effect.tgt);
      return;
    }
    case "unsplit": {
      const parent = get(tree, effect.gid);
      if (parent.status !== "split") throw new DerivationError(`${parent.id} is not split`);
      for (const child of parent.children) discard(tree, child);
      parent.children = [];
      parent.status = "open";
      return;
    }
    case "proved": {
      const goal = get(tree, effect.gid);
      goal.status = "proved";
      // A split goal is proved by its children, so proving the last one
      // discharges the parent, and so on up to the root.
      settle(tree, goal.parent);
      return;
    }
    case "refuted": {
      get(tree, effect.gid).status = "refuted";
      return;
    }
  }
}

function settle(tree: Tree, id: GoalId | undefined): void {
  if (id === undefined) return;
  const goal = get(tree, id);
  if (goal.status !== "split") return;
  const children = goal.children.map((child) => get(tree, child));
  if (!children.every((child) => child.status === "proved")) return;
  goal.status = "proved";
  settle(tree, goal.parent);
}

function discard(tree: Tree, id: GoalId): void {
  const goal = get(tree, id);
  for (const child of goal.children) discard(tree, child);
  tree.goals.delete(id);
}

function get(tree: Tree, id: GoalId): Goal {
  const goal = tree.goals.get(id);
  if (!goal) throw new DerivationError(`no goal ${id}`);
  return goal;
}

/**
 * A goal a step may touch, which is one that has not been cut or refuted.
 *
 * A proved goal may be touched, and touching it reopens it: the proof was
 * about the pair the step is replacing, so it says nothing about the new one.
 * Whatever was settled above it comes undone for the same reason. The old
 * discharge stays in the log, unused, the way abandoned steps do after a
 * revert.
 */
function editable(tree: Tree, id: GoalId): Goal {
  const goal = get(tree, id);
  if (goal.status === "proved") {
    goal.status = "open";
    unsettle(tree, goal.parent);
  }
  if (goal.status !== "open") throw new DerivationError(`${id} is ${goal.status}, not open`);
  return goal;
}

/** Undo the discharges a child's proof carried upwards. */
function unsettle(tree: Tree, id: GoalId | undefined): void {
  if (id === undefined) return;
  const goal = get(tree, id);
  if (goal.status !== "proved") return;
  // A goal with children was proved through them, so it goes back to split.
  goal.status = goal.children.length > 0 ? "split" : "open";
  unsettle(tree, goal.parent);
}

/** The number in a goal id, or 0 for one that is not named that way. */
function number(id: GoalId): number {
  const found = id.match(/^g(\d+)$/);
  return found ? Number(found[1]) : 0;
}

/** The ids the next cut will give its two children. */
export function nextGoalIds(tree: Tree): { outer: GoalId; callee: GoalId } {
  return { outer: `g${tree.nextGoal}`, callee: `g${tree.nextGoal + 1}` };
}

function name(tree: Tree, hash: Hash): void {
  if (!tree.programs.has(hash)) tree.programs.set(hash, `p${tree.programs.size + 1}`);
}
