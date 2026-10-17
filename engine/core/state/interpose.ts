// Proving a goal through a program between its two sides.
//
// A goal claims that its tgt refines its src, and refinement is transitive,
// so any program between them turns the claim into two: the program refines
// the src, and the tgt refines the program. This rewrites the goal rather than
// decomposing it. No program is taken apart: the rewrite path gains a program,
// and the step to it, which one query may not certify, becomes a goal of its
// own that is proved as any goal is, cut at its loops included.
//
// No solver runs here. The program is whatever the caller chose, so a wrong
// one only leaves a goal open.
import { definedIn, type Llops } from "../drivers/llops.ts";
import { type GoalId, head, interposed, nextGoalIds, type Tree, workable } from "./goals.ts";
import type { Store } from "./store.ts";
import type { Effect, Hash } from "./trajectory.ts";

export type InterposeResult =
  | {
      kind: "interposed";
      effects: Effect[];
      /** The program put between the goal's two sides. */
      program: Hash;
      children: { lhs: GoalId; rhs: GoalId };
    }
  | { kind: "refused"; code: string; message: string };

/**
 * Put `program` between the two sides of goal `gid`: child `lhs` claims the
 * program refines the src, and child `rhs` that the tgt refines the program.
 */
export async function interpose(
  store: Store,
  llops: Llops,
  tree: Tree,
  gid: string,
  program: string,
): Promise<InterposeResult> {
  const goal = workable(tree, gid);
  const [src, tgt] = [head(goal, "src"), head(goal, "tgt")];
  const [mine, its] = await Promise.all([
    definedIn(llops, store.get(src), "the goal's src"),
    definedIn(llops, program, "the program"),
  ]);
  if ("why" in its) return { kind: "refused", code: "invalid", message: its.why };
  // alive2 compares functions by name and type; another would be asked nothing.
  if ("why" in mine || mine.name !== its.name) {
    const message = `the program defines @${its.name}, which the goal does not`;
    return { kind: "refused", code: "invalid", message };
  }
  if (mine.type !== its.type) {
    const message = `the program's @${its.name} has type ${its.type}, and the goal's ${mine.type}`;
    return { kind: "refused", code: "invalid", message };
  }
  const hash = await store.put(program);
  if (hash === src || hash === tgt) {
    const message = "the program is one of the goal's sides, so a half would be the goal";
    return { kind: "refused", code: "invalid", message };
  }
  const [lhs, rhs] = nextGoalIds(tree);
  return {
    kind: "interposed",
    program: hash,
    children: { lhs, rhs },
    effects: [
      {
        effect: "interpose",
        gid,
        lhs: { gid: lhs, src, tgt: hash },
        rhs: { gid: rhs, src: hash, tgt },
      },
    ],
  };
}

/** Undo an interpose, discarding its two goals and whatever was proved under them. */
export function uninterpose(tree: Tree, gid: string): Effect[] {
  const goal = tree.goals.get(gid);
  if (!goal) throw new Error(`no goal ${gid}`);
  if (!interposed(tree, goal)) throw new Error(`${gid} is ${goal.status}, not interposed`);
  return [{ effect: "uninterpose", gid }];
}
