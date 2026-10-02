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
  const reads = readsAlike(src, tgt, pairing(src, tgt, a, b, steps));
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
  return out;
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
  const add = (s?: string, t?: string) => s && t && pairs.set(s, t);
  for (const { move, inside } of steps) {
    if (!inside) continue;
    add(src[a[move.src ?? -1]?.[0] ?? -1]?.block, tgt[b[move.tgt ?? -1]?.[0] ?? -1]?.block);
    for (const pair of inside) add(src[pair.src ?? -1]?.value, tgt[pair.tgt ?? -1]?.value);
  }
  return pairs;
}

/** Whether two instructions read the same values and blocks, in order or swapped. */
type Reads = (i: number, j: number, swapped: boolean) => boolean;

/** Constants and arguments must be identical; values and blocks of the bodies must be matched. */
function readsAlike(src: Instruction[], tgt: Instruction[], pairs: Map<string, string>): Reads {
  const own = (body: Instruction[]) =>
    new Set(body.flatMap((i) => [i.block, ...(i.value ? [i.value] : [])]));
  const [mine, theirs] = [own(src), own(tgt)];
  const same = (a: string, b: string) =>
    mine.has(a) || theirs.has(b) ? pairs.get(a) === b : a === b;
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

function isTerminator(instruction: Instruction): boolean {
  return ["ret", "br", "switch", "unreachable"].includes(instruction.opcode);
}
