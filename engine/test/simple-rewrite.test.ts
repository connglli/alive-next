// Tests choosing the moves that bring a goal's two sides closer.
import { describe, expect, test } from "bun:test";
import { Llops } from "../core/drivers/llops.ts";
import { bounded } from "../examples/bounded.ts";
import { strchr } from "../examples/strchr.ts";
import { distance } from "../simple/regions.ts";
import { stagesToward } from "../simple/rewrite.ts";
import { pairs } from "./simple-pairs.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

async function canonical(module: string) {
  const canon = await llops.canon(module);
  if (!canon.ok) throw new Error(canon.message);
  return canon.module;
}

async function body(module: string) {
  const numbered = await llops.number(module);
  if (!numbered.ok) throw new Error(numbered.message);
  return numbered.body;
}

describe.skipIf(!built)("stages", () => {
  test("the walk stops at the last stage closest to the tgt", async () => {
    // At -O1 the optimizer does not vectorize, so -O3's later stages move away.
    const src = await canonical(pairs.e3?.src ?? "");
    const o1 = await llops.pipelineStages(src, "default<O1>");
    const o3 = await llops.pipelineStages(src);
    const tgt = await canonical(o1.ok ? (o1.stages.at(-1)?.module ?? "") : "");
    const walk = await stagesToward(llops, src, tgt);
    expect(walk.length).toBeLessThan(o3.ok ? o3.stages.length : 0);
    expect(distance(await body(walk.at(-1) ?? ""), await body(tgt))).toBe(0);
  });

  test("a stage keeps no loop ID", async () => {
    const looping = bounded.src.replace(
      /br label %head\n}\n$/,
      "br label %head, !llvm.loop !0\n}\n",
    );
    const src = await canonical(
      `${looping}\n!0 = distinct !{!0, !1}\n!1 = !{!"llvm.loop.mustprogress"}\n`,
    );
    const o3 = await llops.pipelineStages(src);
    const tgt = await canonical(o3.ok ? (o3.stages.at(-1)?.module ?? "") : "");
    const walk = await stagesToward(llops, src, tgt);
    expect(src).toContain("!llvm.loop");
    expect(walk.length).toBeGreaterThan(0);
    expect(walk.filter((stage) => stage.includes("!llvm.loop"))).toEqual([]);
  });

  test("no stage is walked when every one is farther than the src", async () => {
    // The optimizer merges the returns into one, which the tgt keeps apart.
    const [src, tgt] = await Promise.all([canonical(strchr.src), canonical(strchr.tgt)]);
    expect(await stagesToward(llops, src, tgt)).toEqual([]);
  });

  test("proposed stages leave no removable body attributes blocking a cut", async () => {
    const src = await canonical(bounded.src);
    const optimized = await llops.pipelineStages(src);
    if (!optimized.ok) throw new Error(optimized.message);
    const shapes = await Promise.all(optimized.stages.map((stage) => llops.validate(stage.module)));
    expect(shapes.some((shape) => shape.ok && shape.body_attrs.length > 0)).toBe(true);
    const tgt = await canonical(optimized.stages.at(-1)?.module ?? src);
    const proposed = await stagesToward(llops, src, tgt);
    expect(proposed.length).toBeGreaterThan(0);
    for (const stage of proposed) {
      const shape = await llops.validate(stage);
      if (!shape.ok) throw new Error(shape.message);
      expect(shape.body_attrs).toEqual([]);
    }
  });
});
