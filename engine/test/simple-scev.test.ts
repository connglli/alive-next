// Tests turning ScalarEvolution's expressions back into instructions.
import { describe, expect, test } from "bun:test";
import type { Scev } from "../core/drivers/llops.ts";
import { build } from "../simple/scev.ts";

const i32 = (value: string): Scev => ({
  op: value.startsWith("%") ? "value" : "const",
  type: "i32",
  value,
});
const node = (op: string, type: string, operands: Scev[]): Scev => ({ op, type, operands });

/** What `build` makes of `tree`, with %x read as %y and fresh names %t0, %t1, ... */
function built(tree: Scev) {
  let n = 0;
  const partner = (value: string) => ({ "%x": "%y", "%p": "%q" })[value];
  return build(tree, partner, () => `%t${n++}`);
}

describe("build", () => {
  test("a sum of a constant and a value reads the value's partner", () => {
    expect(built(node("add", "i32", [i32("-1"), i32("%x")]))).toEqual({
      insts: ["%t0 = add i32 -1, %y"],
      result: "%t0",
    });
  });

  test("a cast keeps both types", () => {
    const tree = node("zext", "i64", [i32("%x")]);
    expect(built(tree)?.insts).toEqual(["%t0 = zext i32 %y to i64"]);
  });

  test("an extreme calls the intrinsic of its name", () => {
    const tree = node("smax", "i32", [i32("0"), i32("%x")]);
    expect(built(tree)?.insts).toEqual(["%t0 = call i32 @llvm.smax.i32(i32 0, i32 %y)"]);
  });

  test("a pointer plus integers is one byte offset from the pointer", () => {
    const p: Scev = { op: "value", type: "ptr", value: "%p" };
    const tree = node("add", "ptr", [i32("4"), p, i32("%x")]);
    expect(built(tree)?.insts).toEqual([
      "%t0 = add i32 4, %y",
      "%t1 = getelementptr i8, ptr %q, i32 %t0",
    ]);
  });

  test("a value without a partner or a recurrence gives nothing", () => {
    expect(built(node("add", "i32", [i32("1"), i32("%z")]))).toBeUndefined();
    const recurrence = { ...node("addrec", "i32", [i32("0"), i32("1")]), loop: "%bb1" };
    expect(built(recurrence)).toBeUndefined();
  });
});
