// Finds where two similar function bodies differ, as regions that a step can
// rewrite one at a time.
//
// The blocks of the two bodies are matched by their contents first, then the
// instructions inside each pair of matched blocks, each time as a longest
// common subsequence. Two matched instructions are the same when they do the
// same operation on matched values. Differences next to each other form one
// region, and an operation whose operands are only swapped is a region of its
// own. A wrong region causes a refused step, never a wrong verdict.
import type { Instruction } from "../core/drivers/llops.ts";

/** The instructions of each body, by index, that differ together. */
export interface Region {
  src: number[];
  tgt: number[];
  /** Whether a window can hold it, which needs no phi and no terminator. */
  window: boolean;
}

/** One step of a matching: an item from each side, or an item from one side only. */
type Move = { src?: number; tgt?: number };

/** A step of the block matching, with the matched instructions when it pairs two blocks. */
type Step = { move: Move; inside?: Move[] };

/** The regions where `tgt` differs from `src`, in the order of the body. */
export function regions(src: Instruction[], tgt: Instruction[]): Region[] {
  return diff(src, tgt).regions;
}

/** How far two bodies are apart: the instructions in the regions where they differ. */
export function distance(src: Instruction[], tgt: Instruction[]): number {
  const size = (region: Region) => region.src.length + region.tgt.length;
  return regions(src, tgt).reduce((sum, region) => sum + size(region), 0);
}

/** The regions, and for each src block and value, the tgt one it is matched with. */
export function diff(srcBody: Instruction[], tgtBody: Instruction[]) {
  // A load or a store of a stack slot matches only one of a slot, never one of memory.
  const [src, tgt] = [slotsMarked(srcBody), slotsMarked(tgtBody)];
  const [a, b] = [blocksOf(src), blocksOf(tgt)];
  const content = (body: Instruction[], block: number[] = []) =>
    block.map((i) => body[i]?.form).join("\n");
  const blocks = settle(
    align(a.length, b.length, (i, j) => content(src, a[i]) === content(tgt, b[j])),
  );
  const steps: Step[] = blocks.map((move) =>
    move.src !== undefined && move.tgt !== undefined
      ? { move, inside: within(src, tgt, a[move.src], b[move.tgt]) }
      : { move },
  );
  const pairs = pairing(src, tgt, a, b, steps);
  const reads = matchedReads(src, tgt, pairs);
  const out: Region[] = [];
  let loose: Region = { src: [], tgt: [], window: false };
  for (const { move, inside } of steps) {
    if (!inside) {
      loose.src.push(...(a[move.src ?? -1] ?? []));
      loose.tgt.push(...(b[move.tgt ?? -1] ?? []));
      continue;
    }
    if (loose.src.length || loose.tgt.length) out.push(loose);
    loose = { src: [], tgt: [], window: false };
    out.push(...group(src, tgt, inside, reads));
  }
  if (loose.src.length || loose.tgt.length) out.push(loose);
  return { regions: out, pairs };
}

/** The blocks and values a body defines, which a diff has to match rather than compare. */
function ownOf(body: Instruction[]): Set<string> {
  return new Set(body.flatMap((i) => [i.block, ...(i.value ? [i.value] : [])]));
}

/** Whether a src name stands for a tgt one: matched when a body defines it, identical otherwise. */
function standsFor(pairs: Map<string, string>, mine: Set<string>, theirs: Set<string>) {
  return (x = "", y = "") => (mine.has(x) || theirs.has(y) ? pairs.get(x) === y : x === y);
}

/** The instruction indices of each block, in the order of the body. */
function blocksOf(body: Instruction[]): number[][] {
  const blocks = new Map<string, number[]>();
  body.forEach((instruction, index) => {
    const block = blocks.get(instruction.block) ?? [];
    block.push(index);
    blocks.set(instruction.block, block);
  });
  return [...blocks.values()];
}

/** The matched instructions of two blocks, as indices into the bodies. */
function within(
  src: Instruction[],
  tgt: Instruction[],
  a: number[] = [],
  b: number[] = [],
): Move[] {
  const moves = settle(
    align(a.length, b.length, (i, j) => src[a[i] ?? -1]?.form === tgt[b[j] ?? -1]?.form),
  );
  return moves.map((move) => ({ src: a[move.src ?? -1], tgt: b[move.tgt ?? -1] }));
}

/**
 * The longest common subsequence of items 0..n-1 and 0..m-1, as steps in order.
 * Equal items at the start and the end are matched first, so the table only
 * covers the middle.
 */
function align(n: number, m: number, same: (i: number, j: number) => boolean): Move[] {
  let head = 0;
  while (head < n && head < m && same(head, head)) head++;
  let tail = 0;
  while (tail < n - head && tail < m - head && same(n - 1 - tail, m - 1 - tail)) tail++;
  const [rows, cols] = [n - head - tail, m - head - tail];
  // at(i, j) is the length of the longest common subsequence from i and j onwards.
  const table = new Uint32Array((rows + 1) * (cols + 1));
  const at = (i: number, j: number) => table[i * (cols + 1) + j] ?? 0;
  for (let i = rows - 1; i >= 0; i--)
    for (let j = cols - 1; j >= 0; j--)
      table[i * (cols + 1) + j] = same(head + i, head + j)
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
  const moves: Move[] = [];
  for (let k = 0; k < head; k++) moves.push({ src: k, tgt: k });
  let [i, j] = [0, 0];
  while (i < rows || j < cols) {
    if (i < rows && j < cols && same(head + i, head + j))
      moves.push({ src: head + i++, tgt: head + j++ });
    else if (j >= cols || (i < rows && at(i + 1, j) >= at(i, j + 1)))
      moves.push({ src: head + i++ });
    else moves.push({ tgt: head + j++ });
  }
  for (let k = tail; k > 0; k--) moves.push({ src: n - k, tgt: m - k });
  return moves;
}

/** Pairs up unmatched items in order wherever a stretch of them has as many on each side. */
function settle(moves: Move[]): Move[] {
  const out: Move[] = [];
  let run: Move[] = [];
  const close = () => {
    const [left, right] = [run.flatMap((m) => m.src ?? []), run.flatMap((m) => m.tgt ?? [])];
    out.push(
      ...(left.length === right.length ? left.map((i, k) => ({ src: i, tgt: right[k] })) : run),
    );
    run = [];
  };
  for (const move of moves) {
    if (move.src === undefined || move.tgt === undefined) run.push(move);
    else {
      close();
      out.push(move);
    }
  }
  close();
  return out;
}

/** For each src block and value, the tgt one it is matched with. */
function pairing(
  src: Instruction[],
  tgt: Instruction[],
  a: number[][],
  b: number[][],
  steps: Step[],
) {
  const pairs = new Map<string, string>();
  const set = (s?: string, t?: string) => s && t && !pairs.has(s) && pairs.set(s, t);
  const value = (body: Instruction[], k?: number) => body[k ?? -1]?.value;
  const block = (body: Instruction[], blocks: number[][], k?: number) =>
    body[blocks[k ?? -1]?.[0] ?? -1]?.block;
  const add = ({ move, inside }: Step) => {
    set(block(src, a, move.src), block(tgt, b, move.tgt));
    for (const pair of inside ?? []) set(value(src, pair.src), value(tgt, pair.tgt));
  };
  const [at, bt] = [indexOf(src, a), indexOf(tgt, b)];
  const stepOf = (s: string, t: string): Step[] => {
    const [i, j] = [at.get(s), bt.get(t)];
    if (i === undefined || j === undefined) return [];
    return [{ move: { src: i, tgt: j }, inside: within(src, tgt, a[i], b[j]) }];
  };
  // Loops go first, since blocks that look the same, such as the calls a cut
  // leaves, can be matched by their contents the wrong way round.
  const loops = loopsPaired(src, tgt).flatMap(([s, t]) => stepOf(s, t));
  const [mine, theirs] = [
    new Set(loops.map(({ move }) => move.src)),
    new Set(loops.map(({ move }) => move.tgt)),
  ];
  const agree = ({ move }: Step) => !mine.has(move.src) && !theirs.has(move.tgt);
  const matched = [...loops, ...steps.filter((step) => step.inside && agree(step))];
  matched.forEach(add);
  const loads = storedLoads(src);
  // Blocks paired through what matched instructions read are matched inside too.
  for (;;) {
    throughOperands(src, tgt, matched, pairs);
    const loaded = throughSlots(src, loads, pairs);
    const done = new Set(matched.map((step) => step.move.src));
    const more = [...pairs].flatMap(([s, t]) => (done.has(at.get(s)) ? [] : stepOf(s, t)));
    if (more.length === 0 && !loaded) return pairs;
    more.forEach(add);
    matched.push(...more);
  }
}

/** Loops of two bodies with as many, in order: header with header, lone exit with exit. */
function loopsPaired(src: Instruction[], tgt: Instruction[]): [string, string][] {
  const [mine, theirs] = [loopsOf(src), loopsOf(tgt)];
  if (mine.length !== theirs.length) return [];
  return mine.flatMap(({ header, exits }, k) => {
    const other = theirs[k];
    if (!other) return [];
    const [exit, otherExit] = [
      exits.length === 1 && exits[0],
      other.exits.length === 1 && other.exits[0],
    ];
    return exit && otherExit
      ? [
          [header, other.header],
          [exit, otherExit],
        ]
      : [[header, other.header]];
  });
}

/** Each loop of `body`, outermost first: its header and the blocks it leaves to. */
function loopsOf(body: Instruction[]) {
  const next = successors(body);
  const before = predecessors(body);
  return headers(body).flatMap((header) => {
    // The loop is what reaches a branch back to its header without passing the header,
    // which holds only when the header dominates those branches, as in LLVM's loops.
    const inside = new Set([header]);
    const work = (before.get(header) ?? []).filter((from) => reaches(next, header, from));
    if (work.some((latch) => !dominates(body, header, latch))) return [];
    for (const block of work) {
      if (inside.has(block)) continue;
      inside.add(block);
      work.push(...(before.get(block) ?? []));
    }
    const leaves = [...inside].flatMap((block) => next.get(block) ?? []);
    return [{ header, exits: [...new Set(leaves.filter((to) => !inside.has(to)))] }];
  });
}

/** Whether every path from the entry of `body` to `block` passes `over`. */
export function dominates(body: Instruction[], over: string, block: string): boolean {
  const next = successors(body);
  const entry = body[0]?.block;
  if (entry === over || over === block) return true;
  const seen = new Set(entry ? [entry] : []);
  for (const from of seen) {
    for (const to of next.get(from) ?? []) if (to !== over) seen.add(to);
  }
  return !seen.has(block);
}

/** Whether `to` can be reached from `from`. */
function reaches(next: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set([from]);
  for (const block of seen) for (const after of next.get(block) ?? []) seen.add(after);
  return seen.has(to);
}

/**
 * The blocks a branch goes back to, outermost first. Blocks are listed in
 * reverse postorder, so a branch to a block listed no later than its own is
 * a loop's back edge.
 */
export function headers(body: Instruction[]): string[] {
  const order = [...new Set(body.map((i) => i.block))];
  const position = new Map(order.map((block, k) => [block, k]));
  const found = new Set<string>();
  for (const i of body)
    for (const to of i.operands)
      if ((position.get(to) ?? Infinity) <= (position.get(i.block) ?? -1)) found.add(to);
  return order.filter((block) => found.has(block));
}

/** Each block's successors: the blocks its instructions name. */
export function successors(body: Instruction[]): Map<string, string[]> {
  const next = new Map(body.map((i) => [i.block, [] as string[]]));
  for (const i of body) next.get(i.block)?.push(...i.operands.filter((to) => next.has(to)));
  return next;
}

/** The blocks of the loop at `header`, which reach its back edges without passing it. */
export function loopOf(next: Map<string, string[]>, before: Map<string, string[]>, header: string) {
  const order = [...next.keys()];
  const at = order.indexOf(header);
  const inside = new Set([header]);
  const todo = order.filter((b, k) => k >= at && next.get(b)?.includes(header));
  for (let block = todo.pop(); block !== undefined; block = todo.pop()) {
    if (inside.has(block)) continue;
    inside.add(block);
    todo.push(...(before.get(block) ?? []));
  }
  return inside;
}

/** Each block's predecessors: the blocks that name it. */
export function predecessors(body: Instruction[]): Map<string, string[]> {
  const before = new Map<string, string[]>();
  for (const [from, tos] of successors(body))
    for (const to of tos) before.set(to, [...(before.get(to) ?? []), from]);
  return before;
}

/** Each block's position among the blocks of `body`, by name. */
function indexOf(body: Instruction[], blocks: number[][]): Map<string, number> {
  return new Map(blocks.map((block, k) => [body[block[0] ?? -1]?.block ?? "", k]));
}

/** Pairs what matched instructions read, a commutative one only where its other operand agrees. */
function throughOperands(
  src: Instruction[],
  tgt: Instruction[],
  steps: Step[],
  pairs: Map<string, string>,
) {
  const [mine, theirs] = [ownOf(src), ownOf(tgt)];
  const agree = standsFor(pairs, mine, theirs);
  for (let grown = true; grown; ) {
    grown = false;
    for (const { inside } of steps)
      for (const { src: i, tgt: j } of inside ?? []) {
        const [s, t] = [src[i ?? -1], tgt[j ?? -1]];
        if (!s || !t || s.form !== t.form) continue;
        // A branch's targets correspond only where its condition already does.
        const chooses = isTerminator(s) && s.operands.length > 1;
        if (chooses && !agree(s.operands[0], t.operands[0])) continue;
        s.operands.forEach((x, k) => {
          const y = t.operands[k] ?? "";
          if (!mine.has(x) || !y.startsWith("%") || pairs.has(x)) return;
          if (s.commutative && !agree(s.operands[1 - k], t.operands[1 - k])) return;
          pairs.set(x, y);
          grown = true;
        });
      }
  }
}

/** Pairs each load that `loads` lists with the partner of the value it reads. */
function throughSlots(src: Instruction[], loads: Map<string, string>, pairs: Map<string, string>) {
  const mine = ownOf(src);
  let grown = false;
  for (const [load, value] of loads) {
    const partner = mine.has(value) ? pairs.get(value) : value;
    if (pairs.has(load) || !partner?.startsWith("%")) continue;
    pairs.set(load, partner);
    grown = true;
  }
  return grown;
}

/** What each load of a stack slot reads, where one store into the slot says which. */
function storedLoads(body: Instruction[]): Map<string, string> {
  const slots = slotsOf(body);
  const loads = new Map<string, string>();
  for (const [k, i] of body.entries()) {
    const slot = i.opcode === "load" ? (i.operands[0] ?? "") : "";
    const value = slots.has(slot) ? storedAt(body, slot, k, i.type) : undefined;
    if (i.value && value) loads.set(i.value, value);
  }
  return loads;
}

/** `body` with a mark on the forms of the loads and stores of its stack slots. */
function slotsMarked(body: Instruction[]): Instruction[] {
  const slots = slotsOf(body);
  const marked = (i: Instruction) =>
    (i.opcode === "load" && slots.has(i.operands[0] ?? "")) ||
    (i.opcode === "store" && slots.has(i.operands[1] ?? ""));
  return body.map((i) => (marked(i) ? { ...i, form: `${i.form} ; slot` } : i));
}

/** The allocas of the entry block that only loads and stores into them use. */
function slotsOf(body: Instruction[]): Set<string> {
  const entry = body[0]?.block;
  const slots = new Set(
    body.flatMap((i) => (i.opcode === "alloca" && i.block === entry && i.value ? [i.value] : [])),
  );
  // A slot that anything but a load or a store into it uses may be written unseen.
  for (const i of body)
    i.operands.forEach((x, k) => {
      if (!(i.opcode === "load" && k === 0) && !(i.opcode === "store" && k === 1)) slots.delete(x);
    });
  return slots;
}

/**
 * What stack slot `slot` holds before instruction `k`, where one store of a
 * `type` into it comes last on every path there, as long as nothing but loads
 * and stores uses the slot.
 */
export function storedAt(body: Instruction[], slot: string, k: number, type: string) {
  const before = predecessors(body);
  // Each block's last instruction, since a map keeps the last value set for a key.
  const ends = new Map(body.map((i, j) => [i.block, j]));
  // The last store into the slot from `end` back to the block's start, or -1 at the entry.
  const lastIn = (block: string, end: number) => {
    for (let j = end; j >= 0 && body[j]?.block === block; j--)
      if (body[j]?.opcode === "store" && body[j]?.operands[1] === slot) return j;
    return before.get(block)?.length ? undefined : -1;
  };
  const found = new Set<number>();
  const entered = new Set<string>();
  const todo: [string, number][] = [[body[k]?.block ?? "", k - 1]];
  for (let next = todo.pop(); next; next = todo.pop()) {
    const [block, end] = next;
    const last = lastIn(block, end);
    if (last !== undefined) found.add(last);
    else
      for (const from of before.get(block) ?? [])
        if (!entered.has(from)) {
          entered.add(from);
          todo.push([from, ends.get(from) ?? -1]);
        }
  }
  const store = found.size === 1 ? body[[...found][0] ?? -1] : undefined;
  return store?.form.startsWith(`store ${type} `) ? store.operands[0] : undefined;
}

/** Whether two instructions read the same values and blocks, in order or swapped. */
type Reads = (i: number, j: number, swapped: boolean) => boolean;

/** Constants and arguments must be identical; values and blocks of the bodies must be matched. */
function matchedReads(src: Instruction[], tgt: Instruction[], pairs: Map<string, string>): Reads {
  const same = standsFor(pairs, ownOf(src), ownOf(tgt));
  const read = (i?: Instruction) => [...(i?.operands ?? []), ...(i?.blocks ?? [])];
  return (i, j, swapped) => {
    const [a, b] = [read(src[i]), read(tgt[j])];
    const order = swapped ? [1, 0] : [];
    return a.length === b.length && a.every((name, k) => same(name, b[order[k] ?? k] ?? ""));
  };
}

/** The regions inside one pair of matched blocks. */
function group(src: Instruction[], tgt: Instruction[], moves: Move[], reads: Reads): Region[] {
  const out: Region[] = [];
  let open: Region = { src: [], tgt: [], window: true };
  const close = () => {
    if (open.src.length || open.tgt.length) out.push(finish(src, tgt, open));
    open = { src: [], tgt: [], window: true };
  };
  for (const move of moves) {
    if (
      move.src !== undefined &&
      move.tgt !== undefined &&
      src[move.src]?.form === tgt[move.tgt]?.form
    ) {
      if (reads(move.src, move.tgt, false)) {
        close();
        continue;
      }
      if (src[move.src]?.commutative && reads(move.src, move.tgt, true)) {
        close();
        open = { src: [move.src], tgt: [move.tgt], window: true };
        close();
        continue;
      }
    }
    if (move.src !== undefined) open.src.push(move.src);
    if (move.tgt !== undefined) open.tgt.push(move.tgt);
  }
  close();
  return out;
}

/** A region that holds a phi or a terminator cannot be a window. */
function finish(src: Instruction[], tgt: Instruction[], region: Region): Region {
  const fixed = (i: Instruction | undefined) => !i || i.phi || isTerminator(i);
  const window = !region.src.some((i) => fixed(src[i])) && !region.tgt.some((j) => fixed(tgt[j]));
  return { ...region, window };
}

export function isTerminator(instruction: Instruction): boolean {
  return ["ret", "br", "switch", "unreachable"].includes(instruction.opcode);
}
