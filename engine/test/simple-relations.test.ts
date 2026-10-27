// Tests finding linear relations among the values a cut passes.
import { describe, expect, test } from "bun:test";
import { Llops } from "../core/drivers/llops.ts";
import { copiedphi } from "../examples/copiedphi.ts";
import { countdown } from "../examples/countdown.ts";
import { offset } from "../examples/offset.ts";
import { relationsAt } from "../simple/relations.ts";
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

describe.skipIf(!built)("relations", () => {
  test("two counters of one loop relate through its iterations", async () => {
    // i counts up from 0 and left down from n, so i - n + left is always 0.
    const module = await canonical(countdown.tgt);
    const side = { module, point: "%4", values: ["%1", "%2", "%0", "%3"], loop: "%bb1" };
    const found = await relationsAt(llops, [side], ["i32", "i32", "i32", "i32"]);
    expect(found).toEqual([
      {
        insts: [
          "%rel0 = mul i32 -1, !2",
          "%rel1 = add i32 !0, %rel0",
          "%rel2 = add i32 %rel1, !3",
          "%rel3 = icmp eq i32 %rel2, 0",
        ],
      },
    ]);
  });

  test("two values that are always equal come out as a guess states it", async () => {
    // The phi copies n around the loop.
    const module = await canonical(copiedphi.src);
    const side = { module, point: "%4", values: ["%1", "%2", "%3", "%0"], loop: "%bb1" };
    const found = await relationsAt(llops, [side], ["i32", "i32", "i32", "i32"]);
    expect(found).toEqual([{ op: "eq", lhs: "!1", rhs: "!3" }]);
  });

  test("values relate through what they are computed from", async () => {
    const module = `define i32 @f(i32 %x, i32 %y) {
entry:
  %a = shl i32 %x, 2
  %b = add i32 %y, %x
  %c = add i32 %a, %b
  ret i32 %c
}
`;
    // c is 4x + (x + y), so c - a - b is always 0.
    const side = { module, point: "#3", values: ["%a", "%b", "%c"] };
    expect(await relationsAt(llops, [side], ["i32", "i32", "i32"])).toEqual([
      {
        insts: [
          "%rel0 = mul i32 -1, !0",
          "%rel1 = mul i32 -1, !1",
          "%rel2 = add i32 %rel0, %rel1",
          "%rel3 = add i32 %rel2, !2",
          "%rel4 = icmp eq i32 %rel3, 0",
        ],
      },
    ]);
  });

  test("a narrower value relates to a wider one once widened", async () => {
    // off counts up by 4 in i64 where i counts up by 1 in i32.
    const module = await canonical(offset.tgt);
    const values = ["%3", "%4", "%0", "%1", "%2", "%5"];
    const side = { module, point: "%6", values, loop: "%bb1" };
    const types = ["i32", "i32", "ptr", "i32", "i32", "i64"];
    const found = (await relationsAt(llops, [side], types)).map((p) => JSON.stringify(p));
    expect(found.some((p) => p.includes("trunc i64 !5 to i32"))).toBe(true);
    expect(
      found.filter((p) => p.includes("zext i32 !0") || p.includes("sext i32 !0")),
    ).toHaveLength(2);
  });

  test("a cast definition relates parameters of different widths", async () => {
    const module = `define i16 @f(i8 %n) {
entry:
  %bound = zext i8 %n to i16
  ret i16 %bound
}
`;
    const side = { module, point: "#1", values: ["%n", "%bound"] };
    expect(await relationsAt(llops, [side], ["i8", "i16"])).toEqual([
      { insts: ["%def0 = zext i8 !0 to i16", "%def1 = icmp eq i16 !1, %def0"] },
    ]);
  });

  test("a definition cannot read a value outside the cut parameters", async () => {
    const module = `define i16 @f(i8 %n) {
entry:
  %bound = zext i8 %n to i16
  ret i16 %bound
}
`;
    const side = { module, point: "#1", values: ["%bound"] };
    expect(await relationsAt(llops, [side], ["i16"])).toEqual([]);
  });
});
