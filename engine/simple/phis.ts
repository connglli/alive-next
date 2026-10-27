// Exposes narrower views of target phis at a loop cut. A window introduces
// each truncation, then hoist makes its result a phi. The proposed value map
// retains that correspondence when the diff cannot recover it from the code.
import type { Instruction, Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { diff, headers, isTerminator } from "./regions.ts";
import { bodies } from "./windows.ts";

/** Steps the target to expose narrower state and returns the proposed value matches. */
export async function stepPhis(
  session: Session,
  llops: Llops,
  gid: string,
  [src, tgt]: [Instruction[], Instruction[]],
  [srcCut, tgtCut]: readonly [string, string],
) {
  const bits = (type: string) => Number(type.match(/^i(\d+)$/)?.[1]);
  const phis = tgt.filter((i) => i.block === tgtCut && i.phi);
  const mine = src.filter((i) => i.block === srcCut && i.phi);
  if (!mine.some((s) => phis.some((t) => bits(s.type) < bits(t.type)))) return undefined;
  const loop = headers(tgt).indexOf(tgtCut);
  if (loop < 0 || !headers(src).includes(srcCut)) return undefined;
  const { pairs } = diff(src, tgt);
  const theirs = new Map(tgt.flatMap((i) => (i.value ? [[i.value, i] as const] : [])));
  const wanted = mine.flatMap((i) => {
    if (!i.value) return [];
    const partner = theirs.get(pairs.get(i.value) ?? "");
    const wide = partner?.opcode === "trunc" ? theirs.get(partner.operands[0] ?? "") : partner;
    const k = wide ? phis.indexOf(wide) : -1;
    return wide && k >= 0 && bits(i.type) < bits(wide.type)
      ? [{ source: i.value, type: i.type, wide: k }]
      : [];
  });
  if (wanted.length === 0) return undefined;
  const matched = new Map<string, number>();
  for (const want of wanted) {
    const header = headers(tgt)[loop];
    const current = tgt.filter((i) => i.block === header && i.phi);
    const wide = current[want.wide];
    if (!header || !wide?.value) continue;
    const existing = viewOf(tgt, current, wide, want.type);
    if (existing >= 0) {
      matched.set(want.source, existing);
      continue;
    }
    const first = tgt.findIndex((i) => i.block === header && !i.phi);
    const instruction = tgt[first];
    if (!instruction || isTerminator(instruction)) continue;
    if (!(await addView(session, gid, wide, want.type, first))) continue;
    // Hoisting appends a phi and preserves the order of the loop headers.
    matched.set(want.source, current.length);
    tgt = (await bodies(session, llops, gid))[1];
  }
  if (matched.size === 0) return undefined;
  const header = headers(tgt)[loop];
  if (!header) return undefined;
  const current = tgt.filter((i) => i.block === header && i.phi);
  const matches = new Map<string, string>();
  for (const [source, k] of matched) {
    const value = current[k]?.value;
    if (value) matches.set(source, value);
  }
  return { target: header, matches };
}

/** The phi already carrying the truncated incoming values of `wide`, or -1. */
function viewOf(body: Instruction[], phis: Instruction[], wide: Instruction, type: string) {
  const definitions = new Map(body.flatMap((i) => (i.value ? [[i.value, i] as const] : [])));
  return phis.findIndex(
    (phi) =>
      phi.type === type &&
      phi.operands.length === wide.operands.length &&
      phi.operands.every((value, k) => {
        const cast = definitions.get(value);
        const edge = wide.blocks?.indexOf(phi.blocks?.[k] ?? "") ?? -1;
        return (
          cast?.opcode === "trunc" &&
          cast.flags.length === 0 &&
          edge >= 0 &&
          cast.operands[0] === wide.operands[edge]
        );
      }),
  );
}

/** Adds a narrow view through a window and hoists it, undoing an unfinished attempt. */
async function addView(session: Session, gid: string, wide: Instruction, type: string, at: number) {
  const before = (await session.show(gid)).tgt.id;
  const point = `#${at}`;
  await session.begin(gid, "tgt");
  const inserted = await session.edit({
    op: "insert",
    where: "before",
    w: point,
    insts: [`%view = trunc ${wide.type} ${wide.value} to ${type}`],
  });
  if (inserted.kind !== "applied") {
    await session.abort();
    return false;
  }
  const step = await session.commit({
    window: { from: point, to: point },
    whole: false,
    eager: false,
  });
  if (step.kind !== "certified") return false;
  await session.begin(gid, "tgt");
  const hoisted = await session.edit({ op: "hoist", v: point });
  if (hoisted.kind !== "applied") await session.abort();
  else if ((await session.commit({ narrow: false, eager: false })).kind === "certified")
    return true;
  await session.revert(gid, "tgt", before);
  return false;
}
