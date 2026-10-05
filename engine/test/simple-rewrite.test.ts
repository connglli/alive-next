// Tests choosing the moves that bring a goal's two sides closer.
import { describe, expect, test } from "bun:test";
import { Llops } from "../core/drivers/llops.ts";
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

  test("no stage is walked when every one is farther than the src", async () => {
    // The optimizer merges the returns into one, which the tgt keeps apart.
    const [src, tgt] = await Promise.all([canonical(strchr.src), canonical(strchr.tgt)]);
    expect(await stagesToward(llops, src, tgt)).toEqual([]);
  });
});
