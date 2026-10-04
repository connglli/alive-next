// Gives the src its own value where a cut left it passing poison. A value only
// the tgt has crosses a cut as poison on the src side, which no fact holds
// for, so each call that passes it is stepped to pass what the tgt passes
// there: the value's partner, or its expression rebuilt from partners. The
// step is certified because a value refines poison.
import type { Instruction, Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import type { SplitResult } from "../core/state/splits.ts";
import { diff } from "./regions.ts";
import { build } from "./scev.ts";
import { bodies } from "./windows.ts";

/** Fills what cut `split` left the src passing as poison. */
export async function fillCut(
  session: Session,
  llops: Llops,
  split: Extract<SplitResult, { kind: "split" }>,
) {
  if (!split.params.some((param) => param.live === "poison")) return true;
  const types = split.params.map((param) => param.type);
  const { outer, callee } = split.children;
  if (!(await fill(session, llops, outer, split.callee, types))) return false;
  const hypothesis = split.detach?.hypothesis;
  return !hypothesis || (await fill(session, llops, callee, hypothesis, types));
}

/** Steps goal `gid`'s src to pass the tgt's values where its calls of `fn` pass poison. */
export async function fill(
  session: Session,
  llops: Llops,
  gid: string,
  fn: string,
  types: string[],
): Promise<boolean> {
  for (;;) {
    const [src, tgt] = await bodies(session, llops, gid);
    const [mine, theirs] = [callsOf(src, fn), callsOf(tgt, fn)];
    if (mine.length !== theirs.length) return false;
    const c = mine.findIndex((k, n) => holes(src[k], tgt[theirs[n] ?? -1]).length > 0);
    if (c < 0) return true;
    if (!(await fillCall(session, llops, gid, [src, tgt], [mine[c], theirs[c]], types)))
      return false;
  }
}

/** Steps one call of the src to pass what its tgt partner passes where it passes poison. */
async function fillCall(
  session: Session,
  llops: Llops,
  gid: string,
  [src, tgt]: [Instruction[], Instruction[]],
  [i, j]: (number | undefined)[],
  types: string[],
) {
  const [call, theirs] = [src[i ?? -1], tgt[j ?? -1]];
  if (!call || !theirs) return false;
  const partner = partnerOf(src, tgt);
  const analysis = await llops.analyze((await session.show(gid)).tgt.text, "scev", `#${j}`);
  const scev = (value: string) =>
    analysis.ok ? analysis.facts.find((fact) => fact.value === value)?.scev : undefined;
  let n = 0;
  const fresh = () => `%own${n++}`;
  const insts: string[] = [];
  const args = [...(call.args ?? [])];
  for (const k of holes(call, theirs)) {
    const value = theirs.args?.[k] ?? "";
    const own = partner(value);
    const tree = own === undefined ? scev(value) : undefined;
    const built = tree && build(tree, partner, fresh);
    if (own === undefined && !built) return false;
    insts.push(...(built?.insts ?? []));
    args[k] = own ?? built?.result ?? "";
  }
  const passed = args.map((arg, k) => `${types[k]} ${arg}`).join(", ");
  const named = call.value ? `${fresh()} = ` : "";
  insts.push(`${named}call ${call.type} ${call.calls}(${passed})`);
  await session.begin(gid, "src");
  const edited = await session.edit({ op: "replace", v: `#${i}`, insts });
  if (edited.kind === "refused") {
    await session.abort();
    return false;
  }
  return (await session.commit({ eager: false })).kind === "certified";
}

/** The positions of `body`'s calls of `fn`, in order. */
function callsOf(body: Instruction[], fn: string): number[] {
  return body.flatMap((instruction, k) => (instruction.calls === `@${fn}` ? [k] : []));
}

/** Where a src call passes poison and its tgt partner passes something else. */
function holes(mine?: Instruction, theirs?: Instruction): number[] {
  return (mine?.args ?? []).flatMap((arg, k) =>
    arg === "poison" && theirs?.args?.[k] && theirs.args[k] !== "poison" ? [k] : [],
  );
}

/** The src name for a tgt name: its partner if the tgt body defines it, else itself. */
function partnerOf(src: Instruction[], tgt: Instruction[]) {
  const back = new Map([...diff(src, tgt).pairs].map(([s, t]) => [t, s]));
  const theirs = new Set(tgt.flatMap((instruction) => instruction.value ?? []));
  return (value: string) => (theirs.has(value) ? back.get(value) : value);
}
