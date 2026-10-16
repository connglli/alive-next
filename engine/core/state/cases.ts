// Proving a goal by cases on its inputs.
//
// A goal claims that its tgt refines its src on every input, and refinement
// holds input by input, so the inputs can be split, the two cases restricting
// both programs the same way. One split is on whether a parameter is poison:
// the case where it is not makes it noundef, and the case where it is puts
// poison in its place, and a scalar argument is one or the other. The other is
// on a comparison of parameters, assumed at the start of the function in one
// case and its inverse in the other, which cover every input the src does not
// make undefined once the parameters compared are noundef in the src, since a
// poison argument is undefined behavior there already. Splitting a parameter
// on its poison first is what makes it noundef where it is not. This
// decomposes the goal, as a cut does, but by inputs rather than by code.
//
// No solver runs here. The cases are what `llops attrs`, `poison` and `assume`
// make of the goal's pair, and each is proved afterwards as a goal of its own.
import { type Comparison, definedIn, type Llops, type LlopsResult } from "../drivers/llops.ts";
import { cased, type Goal, type GoalId, head, nextGoalIds, type Tree, workable } from "./goals.ts";
import type { Store } from "./store.ts";
import type { CaseOn, Effect, Hash } from "./trajectory.ts";

export type CaseResult =
  | {
      kind: "cased";
      effects: Effect[];
      /** The goal where what it splits on holds, and the one where it does not. */
      children: { holds: GoalId; fails: GoalId };
    }
  | { kind: "refused"; code: string; message: string };

/** Each comparison's inverse, which holds exactly where it fails on values that are not poison. */
export const INVERSE: Record<Comparison["op"], Comparison["op"]> = {
  eq: "ne",
  ne: "eq",
  slt: "sge",
  sge: "slt",
  sgt: "sle",
  sle: "sgt",
  ult: "uge",
  uge: "ult",
  ugt: "ule",
  ule: "ugt",
};

/** A program of each side, as the store names it. */
type Pair = { src: Hash; tgt: Hash };

/**
 * Cut goal `gid` by cases on `on`: whether a parameter (`!N`) is poison, or a
 * comparison of two parameters or of one and an integer. Child `holds` is the
 * pair where it holds, and child `fails` where it does not.
 */
export async function cases(
  store: Store,
  llops: Llops,
  tree: Tree,
  gid: string,
  on: CaseOn,
): Promise<CaseResult> {
  const goal = workable(tree, gid);
  const src = store.get(head(goal, "src"));
  const fn = await definedIn(llops, src, "the goal's src");
  if ("why" in fn) return { kind: "refused", code: "invalid", message: fn.why };
  const made =
    "defined" in on
      ? await byPoison(store, llops, goal, fn.name, on.defined)
      : await byComparison(store, llops, goal, fn.name, on);
  if ("why" in made) return { kind: "refused", code: "invalid", message: made.why };
  const [h, f] = nextGoalIds(tree);
  return {
    kind: "cased",
    children: { holds: h, fails: f },
    effects: [
      {
        effect: "case",
        gid,
        on,
        holds: { gid: h, ...made.holds },
        fails: { gid: f, ...made.fails },
      },
    ],
  };
}

/** Undo a cut by cases, discarding its two goals and whatever was proved under them. */
export function uncase(tree: Tree, gid: string): Effect[] {
  const goal = tree.goals.get(gid);
  if (!goal) throw new Error(`no goal ${gid}`);
  if (!cased(tree, goal)) throw new Error(`${gid} is ${goal.status}, not cut by cases`);
  return [{ effect: "uncase", gid }];
}

/** The cases where parameter `name` is not poison, made noundef, and where it is, put in its place. */
async function byPoison(
  store: Store,
  llops: Llops,
  goal: Goal,
  fn: string,
  name: string,
): Promise<{ holds: Pair; fails: Pair } | { why: string }> {
  const param = paramOf(name);
  if (param === undefined) return { why: `${name} is not a parameter, written !N` };
  const holds = await both(store, goal, (module) =>
    llops.attrs(module, fn, { noundef: true }, param),
  );
  if ("why" in holds) return holds;
  const fails = await both(store, goal, (module) => llops.poison(module, param));
  if ("why" in fails) return fails;
  return { holds, fails };
}

/** The cases where comparison `c` holds and where its inverse does, assumed at the start. */
async function byComparison(
  store: Store,
  llops: Llops,
  goal: Goal,
  fn: string,
  c: Comparison,
): Promise<{ holds: Pair; fails: Pair } | { why: string }> {
  const why = await unfit(llops, store.get(head(goal, "src")), c);
  if (why) return { why };
  const start = { at: "start" as const, fn };
  const holds = await both(store, goal, (module) => llops.assume(module, start, [c]));
  if ("why" in holds) return holds;
  const inverse: Comparison = { ...c, op: INVERSE[c.op] };
  const fails = await both(store, goal, (module) => llops.assume(module, start, [inverse]));
  if ("why" in fails) return fails;
  return { holds, fails };
}

/**
 * Why comparison `c` cannot cut a goal whose src is `src`, or nothing. It
 * compares parameters or a parameter and an integer, and each parameter it
 * names is noundef in the src, or a poison argument would lie in no case.
 */
async function unfit(llops: Llops, src: string, c: Comparison): Promise<string | undefined> {
  if (!Object.hasOwn(INVERSE, c.op)) return `${c.op} is no comparison`;
  const named = [c.lhs, c.rhs].filter((x) => typeof x === "string");
  if (named.length === 0) return "the comparison names no parameter";
  const result = await llops.validate(src);
  if (!result.ok) return `the goal's src: llops validate: ${result.message}`;
  const params = Object.values(result.functions ?? {}).find((fn) => fn.defined)?.params ?? [];
  for (const name of named) {
    const k = paramOf(name);
    const param = k === undefined ? undefined : params[k];
    if (!param) return `${name} is not a parameter, written !N`;
    if (param.attrs.noundef !== true)
      return `${name} may be poison in the src, which lies in no case of a comparison; split on whether it is poison first`;
  }
  return undefined;
}

/** The index a parameter name `!N` gives, if it is one. */
function paramOf(name: string): number | undefined {
  const k = /^!(0|[1-9]\d*)$/.exec(name)?.[1];
  return k === undefined ? undefined : Number(k);
}

/** Both programs of `goal`, each made into its case by `make` and stored. */
async function both(
  store: Store,
  goal: Goal,
  make: (module: string) => Promise<LlopsResult<{ module: string }>>,
): Promise<Pair | { why: string }> {
  const src = await make(store.get(head(goal, "src")));
  if (!src.ok) return { why: `the src: ${src.message}` };
  const tgt = await make(store.get(head(goal, "tgt")));
  if (!tgt.ok) return { why: `the tgt: ${tgt.message}` };
  return { src: await store.put(src.module), tgt: await store.put(tgt.module) };
}
