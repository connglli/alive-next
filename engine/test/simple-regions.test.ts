// Tests the simple searcher's diff on canonical programs, as a session stores them.
import { describe, expect, test } from "bun:test";
import { Llops } from "../core/drivers/llops.ts";
import { countdown } from "../examples/countdown.ts";
import { peel } from "../examples/peel.ts";
import { distance, dominates, diff as match, regions } from "../simple/regions.ts";
import { pairs } from "./simple-pairs.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

async function body(module: string) {
  const canon = await llops.canon(module);
  if (!canon.ok) throw new Error(canon.message);
  const numbered = await llops.number(canon.module);
  if (!numbered.ok) throw new Error(numbered.message);
  return numbered.body;
}

async function diff(src: string, tgt: string) {
  return regions(await body(src), await body(tgt));
}

/** Regions as `src/tgt` lists of indices. */
const shown = (found: { src: number[]; tgt: number[] }[]) => found.map((r) => `${r.src}/${r.tgt}`);

describe.skipIf(!built)("regions", () => {
  test("find the regions of the small pairs", async () => {
    // e3's last add is in no region, because each division is matched with the
    // vector lane extracted for it, so the add reads the same values on both
    // sides. e4's mul reads the freeze the tgt dropped where the tgt's reads
    // the shl, so the two pair up and the freeze alone differs.
    const expected: Record<string, string[]> = {
      e1: ["1/1", "3/3", "4/4", "6/6"],
      e1alt: ["2/2", "4/4", "6/6", "7/7"],
      e2: ["1/1", "3,4/3,4", "5/5"],
      e3: ["0/0", "3,4,5,6/3,4,5,6,7,8,9,10"],
      e4: ["2/"],
      varA: ["2/2"],
      varB: ["0,1/0,1", "3/3"],
    };
    for (const [name, pair] of Object.entries(pairs))
      expect([name, shown(await diff(pair.src, pair.tgt))]).toEqual([name, expected[name] ?? []]);
  });

  test("an inserted instruction leaves the rest aligned", async () => {
    const src = `define i32 @f(i32 %x, i32 %y) {
entry:
  %a = add i32 %x, %y
  %b = mul i32 %a, %x
  %c = sub i32 %b, %y
  ret i32 %c
}
`;
    const tgt = src.replace(
      "  %b = mul i32 %a, %x\n",
      "  %n = xor i32 %a, 1\n  %b = mul i32 %a, %x\n",
    );
    expect(shown(await diff(src, tgt))).toEqual(["/1"]);
  });

  test("the distance counts both sides of every region", async () => {
    // e2's regions are 1/1, 3,4/3,4 and 5/5.
    const e2 = pairs.e2;
    if (!e2) throw new Error("no pair e2");
    expect(distance(await body(e2.src), await body(e2.tgt))).toBe(8);
    expect(distance(await body(e2.src), await body(e2.src))).toBe(0);
  });

  test("an added block changes only what branches to it", async () => {
    const src = `define i32 @f(i32 %n) {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %i.next = add i32 %i, 1
  %c = icmp ult i32 %i.next, %n
  br i1 %c, label %loop, label %exit

exit:
  ret i32 %i
}
`;
    const tgt = src
      .replace("  br label %loop\n\nloop:", "  br label %pre\n\npre:\n  br label %loop\n\nloop:")
      .replace("[ 0, %entry ]", "[ 0, %pre ]");
    // The regions are the entry's branch, the new block, and the phi that now
    // comes from it.
    expect(shown(await diff(src, tgt))).toEqual(["0/0", "/1", "1/2"]);
  });

  test("control flow that differs makes each body one region", async () => {
    const src = `define i32 @f(i1 %c, i32 %x) {
entry:
  br i1 %c, label %a, label %b

a:
  ret i32 %x

b:
  ret i32 0
}
`;
    const tgt = `define i32 @f(i1 %c, i32 %x) {
entry:
  %r = select i1 %c, i32 %x, i32 0
  ret i32 %r
}
`;
    const found = await diff(src, tgt);
    expect(found).toEqual([{ src: [0, 1, 2], tgt: [0, 1], window: false }]);
  });

  test("the values two matched instructions read pair up", async () => {
    const src = `define i32 @f(i32 %x) {
entry:
  %a = mul i32 %x, 2
  ret i32 %a
}
`;
    // The returns match, so the mul and the freeze they return pair up,
    // though the two sides compute them in different numbers of steps, and the
    // return stays out of the region, which a window can then hold.
    const tgt = src.replace("%a = mul i32 %x, 2", "%h = shl i32 %x, 1\n  %a = freeze i32 %h");
    expect(await diff(src, tgt)).toEqual([{ src: [0], tgt: [0, 1], window: true }]);
  });

  test("a value pairs with the argument a matched instruction reads", async () => {
    const src = `define i32 @f(i32 %x) {
entry:
  %k = or i32 %x, 0
  %r = mul i32 %k, 3
  ret i32 %r
}
`;
    const copy = "  %k = or i32 %x, 0\n  %r = mul i32 %k, 3";
    const tgt = src.replace(copy, "  %r = mul i32 %x, 3");
    expect(await diff(src, tgt)).toEqual([{ src: [0], tgt: [], window: true }]);
  });

  test("a reshaped loop pairs its phis and exits, not its body with an exit", async () => {
    // The tgt if-converts the body and branches to the exit on another test.
    const { pairs } = match(await body(countdown.src), await body(countdown.tgt));
    expect([pairs.get("%1"), pairs.get("%2")]).toEqual(["%1", "%2"]);
    expect([pairs.get("%bb2"), pairs.get("%bb3")]).toEqual(["%bb3", undefined]);
  });

  test("loops that look different pair header with header and exit with exit", async () => {
    // The tgt peels the first iteration, so no block matches by its contents.
    const { pairs } = match(await body(peel.src), await body(peel.tgt));
    expect([pairs.get("%bb1"), pairs.get("%bb2")]).toEqual(["%bb2", "%bb3"]);
    expect([pairs.get("%2"), pairs.get("%3")]).toEqual(["%4", "%5"]);
  });

  test("a cycle entered at two points is not paired as a loop", async () => {
    // The src enters its cycle at %a or at %b, so %a heads no loop.
    const src = `define i32 @f(i1 %c, i32 %x) {
entry:
  br i1 %c, label %a, label %b

a:
  %p = phi i32 [ %x, %entry ], [ %q, %b ]
  %y = add i32 %p, 1
  br label %b

b:
  %q = phi i32 [ %x, %entry ], [ %y, %a ]
  %d = icmp ult i32 %q, 100
  br i1 %d, label %a, label %exit

exit:
  ret i32 %q
}
`;
    const tgt = `define i32 @f(i1 %c, i32 %x) {
entry:
  %s = select i1 %c, i32 1, i32 0
  %z = add i32 %x, %s
  br label %h

h:
  %q = phi i32 [ %z, %entry ], [ %y, %h ]
  %y = add i32 %q, 1
  %d = icmp ult i32 %q, 100
  br i1 %d, label %h, label %exit

exit:
  ret i32 %q
}
`;
    const { pairs } = match(await body(src), await body(tgt));
    expect([pairs.get("%bb1"), pairs.get("%4")]).toEqual([undefined, "%4"]);
  });

  test("a block dominates what every path from the entry reaches through it", async () => {
    const diamond = await body(`define i32 @f(i1 %c) {
entry:
  br i1 %c, label %a, label %b

a:
  br label %join

b:
  br label %join

join:
  ret i32 0
}
`);
    const over = (block: string) => dominates(diamond, block, "%bb3");
    expect([over("%entry"), over("%bb1"), over("%bb3")]).toEqual([true, false, true]);
  });

  test("a region that holds a terminator is no window", async () => {
    const src = `define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  ret i32 %a
}
`;
    const found = await diff(src, src.replace("ret i32 %a", "ret i32 %x"));
    expect(found).toEqual([{ src: [1], tgt: [1], window: false }]);
  });
});
