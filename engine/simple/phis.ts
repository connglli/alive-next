// Aligns integer loop state matched directly or through casts. A wider target
// gets a certified narrow view; a source phi used only by a header truncation
// is replaced by that hoisted cast. Phi positions keep value matches stable.
import type { Instruction, Llops } from "../core/drivers/llops.ts";
import type { Session } from "../core/session.ts";
import { diff, headers, isTerminator } from "./regions.ts";
import { bodies } from "./windows.ts";

/** Prepares compatible phi types and returns the cut points and value matches. */
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
  const differ = (s: Instruction, t: Instruction) =>
    bits(s.type) < bits(t.type) || bits(s.type) > bits(t.type);
  if (!mine.some((s) => phis.some((t) => differ(s, t)))) return undefined;
  const [sourceLoop, targetLoop] = [headers(src).indexOf(srcCut), headers(tgt).indexOf(tgtCut)];
  if (sourceLoop < 0 || targetLoop < 0) return undefined;
  const { pairs } = diff(src, tgt);
  const theirs = new Map(tgt.flatMap((i) => (i.value ? [[i.value, i] as const] : [])));
  const wanted = mine.flatMap((i, source) => {
    if (!i.value || !Number.isFinite(bits(i.type))) return [];
    const cast = castOf(src, i);
    const narrowed = theirs.get(pairs.get(cast?.value ?? "") ?? "");
    const narrow = narrowed ? phis.indexOf(narrowed) : -1;
    if (narrow >= 0 && narrowed?.type === cast?.type) return [{ source, target: narrow }];
    const partner = theirs.get(pairs.get(i.value) ?? "");
    const state = partner?.opcode === "trunc" ? theirs.get(partner.operands[0] ?? "") : partner;
    const k = state ? phis.indexOf(state) : -1;
    if (state && k >= 0 && differ(i, state)) return [{ source, target: k }];
    // A widened counter can match a source extension instead of its phi.
    const extended = src.flatMap((cast) => {
      if (cast.operands[0] !== i.value || (cast.opcode !== "zext" && cast.opcode !== "sext"))
        return [];
      const partner = theirs.get(pairs.get(cast.value ?? "") ?? "");
      const target = partner ? phis.indexOf(partner) : -1;
      return target >= 0 && partner?.type === cast.type ? [target] : [];
    });
    const [target, ...others] = [...new Set(extended)];
    return target !== undefined && others.length === 0 ? [{ source, target }] : [];
  });
  if (wanted.length === 0) return undefined;
  const matched = new Map<number, number>();
  for (const want of wanted) {
    const source = headers(src)[sourceLoop];
    const header = headers(tgt)[targetLoop];
    const from = src.filter((i) => i.block === source && i.phi)[want.source];
    const current = tgt.filter((i) => i.block === header && i.phi);
    const to = current[want.target];
    if (!source || !header || !from || !to?.value) continue;
    if (bits(from.type) > bits(to.type)) {
      if (!(await narrowSource(session, llops, gid, src, from, to.type))) continue;
      matched.set(want.source, want.target);
      src = (await bodies(session, llops, gid))[0];
      continue;
    }
    const existing = viewOf(tgt, current, to, from.type);
    if (existing >= 0) {
      matched.set(want.source, existing);
      continue;
    }
    const first = tgt.findIndex((i) => i.block === header && !i.phi);
    const instruction = tgt[first];
    if (!instruction || isTerminator(instruction)) continue;
    if (!(await addView(session, gid, to, from.type, first))) continue;
    // Hoisting appends a phi and preserves the order of the loop headers.
    matched.set(want.source, current.length);
    tgt = (await bodies(session, llops, gid))[1];
  }
  if (matched.size === 0) return undefined;
  const source = headers(src)[sourceLoop];
  const header = headers(tgt)[targetLoop];
  if (!source || !header) return undefined;
  const sources = src.filter((i) => i.block === source && i.phi);
  const current = tgt.filter((i) => i.block === header && i.phi);
  const matches = new Map<string, string>();
  for (const [at, k] of matched) {
    const mine = sources[at]?.value;
    const value = current[k]?.value;
    if (mine && value) matches.set(mine, value);
  }
  return { source, target: header, matches };
}

/** A phi's sole user, when it is a truncation in the same header. */
function castOf(body: Instruction[], phi: Instruction) {
  const users = body.filter((i) => i.operands.includes(phi.value ?? ""));
  const cast = users[0];
  return users.length === 1 && cast?.opcode === "trunc" && cast.block === phi.block
    ? cast
    : undefined;
}

/** Hoists the source's existing truncation and removes the phi it leaves unused. */
async function narrowSource(
  session: Session,
  llops: Llops,
  gid: string,
  body: Instruction[],
  wide: Instruction,
  type: string,
) {
  const header = wide.block;
  const position = body.filter((i) => i.block === header && i.phi).indexOf(wide);
  const cast = castOf(body, wide);
  if (!cast || cast.type !== type) return false;
  const loop = headers(body).indexOf(header);
  const first = body.findIndex((i) => i.block === header && !i.phi);
  const at = body.indexOf(cast);
  const before = (await session.show(gid)).src.id;
  if (at !== first && !(await moveCast(session, gid, at, first))) return false;
  let kept = false;
  if (await hoist(session, gid, "src", first)) {
    const source = (await bodies(session, llops, gid))[0];
    const currentHeader = headers(source)[loop];
    const phis = source.filter((i) => i.block === currentHeader && i.phi);
    const old = source.indexOf(phis[position] as Instruction);
    const last = source.indexOf(phis.at(-1) as Instruction);
    if (old >= 0 && last > old) kept = await replacePhi(session, gid, old, last);
  }
  if (!kept && (await session.show(gid)).src.id !== before)
    await session.revert(gid, "src", before);
  return kept;
}

/** Moves a cast to the header's first ordinary instruction through a checked window. */
async function moveCast(session: Session, gid: string, at: number, first: number) {
  await session.begin(gid, "src");
  const moved = await session.edit({ op: "move", v: `#${at}`, where: "before", w: `#${first}` });
  if (moved.kind !== "applied") {
    await session.abort();
    return false;
  }
  const checked = await session.commit({
    window: { from: `#${first}`, to: `#${at}` },
    whole: false,
    eager: false,
  });
  return checked.kind === "certified";
}

/** Replaces the unused phi with the appended view, preserving the other phis' positions. */
async function replacePhi(session: Session, gid: string, old: number, last: number) {
  await session.begin(gid, "src");
  const moved = await session.edit({ op: "move", v: `#${last}`, where: "before", w: `#${old}` });
  const erased =
    moved.kind === "applied" ? await session.edit({ op: "erase", v: `#${old + 1}` }) : undefined;
  if (erased?.kind !== "applied") {
    await session.abort();
    return false;
  }
  return (await session.commit({ narrow: false, eager: false })).kind === "certified";
}

/** Hoists the first ordinary instruction through a whole-function check. */
async function hoist(session: Session, gid: string, side: "src" | "tgt", at: number) {
  await session.begin(gid, side);
  const edited = await session.edit({ op: "hoist", v: `#${at}` });
  if (edited.kind !== "applied") {
    await session.abort();
    return false;
  }
  return (await session.commit({ narrow: false, eager: false })).kind === "certified";
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
  if (await hoist(session, gid, "tgt", at)) return true;
  await session.revert(gid, "tgt", before);
  return false;
}
