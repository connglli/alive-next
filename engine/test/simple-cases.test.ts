// Tests which comparisons the simple searcher splits a goal by cases on.
import { describe, expect, test } from "bun:test";
import { Llops } from "../core/drivers/llops.ts";
import { unswitch } from "../examples/unswitch.ts";
import { caseOn, tested } from "../simple/cases.ts";
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
  const numbered = await llops.number(await canonical(module));
  if (!numbered.ok) throw new Error(numbered.message);
  return numbered.body;
}

// The src tests y and then x, and the tgt tests only y, written the other way round.
const SRC = `define i32 @f(i32 noundef %x, i32 noundef %y) {
entry:
  %a = icmp eq i32 %y, 0
  br i1 %a, label %zero, label %other

zero:
  %b = icmp sgt i32 %x, 0
  br i1 %b, label %positive, label %other

positive:
  ret i32 1

other:
  ret i32 0
}
`;
const TGT = `define i32 @f(i32 noundef %x, i32 noundef %y) {
entry:
  %a = icmp ne i32 0, %y
  br i1 %a, label %other, label %zero

zero:
  %b = icmp sgt i32 %x, 0
  %r = zext i1 %b to i32
  ret i32 %r

other:
  ret i32 0
}
`;

describe.skipIf(!built)("cases", () => {
  test("take a later branch's comparison first", async () => {
    // The loop's own test reads its counter, which no case can split on.
    const found = tested(await body(unswitch.src), await body(unswitch.tgt));
    expect(found).toEqual([
      { op: "eq", lhs: "!3", rhs: 0 },
      { op: "slt", lhs: 0, rhs: "!2" },
    ]);
  });

  test("take a comparison both sides test first, as the src writes it", async () => {
    const found = tested(await body(SRC), await body(TGT));
    expect(found).toEqual([
      { op: "eq", lhs: "!1", rhs: 0 },
      { op: "sgt", lhs: "!0", rhs: 0 },
    ]);
  });

  test("leave out a comparison the goal assumes, or its inverse", async () => {
    const assumed = [{ op: "ne", lhs: "!1", rhs: 0 } as const];
    const found = tested(await body(SRC), await body(TGT), assumed);
    expect(found).toEqual([{ op: "sgt", lhs: "!0", rhs: 0 }]);
  });

  test("split a parameter that may be poison first", async () => {
    const on = { op: "eq", lhs: "!1", rhs: 0 } as const;
    expect(await caseOn(llops, await canonical(SRC), on)).toEqual(on);
    const maybe = await canonical(SRC.replace("i32 noundef %y", "i32 %y"));
    expect(await caseOn(llops, maybe, on)).toEqual({ defined: "!1" });
  });
});
