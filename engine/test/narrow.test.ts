// Narrowing a step to the window that changed.
//
// llops is real here, because what is under test is whether the two halves
// come apart the way the checker will put them back together: a narrowing
// nothing verifies is worth nothing.
import { describe, expect, test } from "bun:test";
import { Llops } from "../core/drivers/llops.ts";
import { narrow } from "../core/state/narrow.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

/** The instruction lines of a program's body, which is what a window holds. */
function body(module: string): string[] {
  const lines = module.split("\n");
  const entry = lines.indexOf("entry:");
  return lines.slice(entry + 1, lines.indexOf("}", entry)).map((line) => line.trim());
}

/** Put a narrowing back together, which is what a checker does to it. */
async function inlined(outer: string, callee: string): Promise<string> {
  const back = await llops.inline(outer, callee, "outlined_window");
  if (!back.ok) throw new Error(back.message);
  const canon = await llops.canon(back.module);
  if (!canon.ok) throw new Error(canon.message);
  return canon.module;
}

async function canon(module: string): Promise<string> {
  const done = await llops.canon(module);
  if (!done.ok) throw new Error(done.message);
  return done.module;
}

const HEAD = `define i32 @fun(i32 %p0, i32 %p1) {
entry:
  %v0 = lshr i32 %p0, 22
`;
const TAIL = `  %v3 = add nsw i32 %v0, 1
  %v4 = add nsw i32 %v2, 1
  %v5 = mul nsw i32 %v3, %v4
  ret i32 %v5
}
`;
/** A masked bitfield extraction, rewritten: two instructions of a longer body. */
const BEFORE = `${HEAD}  %v1 = and i32 %p1, 4190208
  %v2 = ashr i32 %v1, 12
${TAIL}`;
const AFTER = `${HEAD}  %v1 = lshr i32 %p1, 12
  %v2 = and i32 %v1, 1023
${TAIL}`;

describe.skipIf(!built)("narrowing a step", () => {
  test("takes the window the edit touched, and leaves the rest", async () => {
    const found = await narrow(llops, await canon(BEFORE), await canon(AFTER));
    if (!found) throw new Error("expected the step to narrow");

    // Two instructions of the ten, which is the whole of what changed.
    expect(body(found.before)).toEqual([
      "%0 = and i32 %p0, 4190208",
      "%1 = ashr i32 %0, 12",
      "ret i32 %1",
    ]);
    expect(body(found.after)).toEqual([
      "%0 = lshr i32 %p0, 12",
      "%1 = and i32 %0, 1023",
      "ret i32 %1",
    ]);
    // The outer is one program, not two that happen to agree: that is what
    // says the difference is confined to the window.
    expect(found.outer).toContain("call i32 @outlined_window");
    expect(await inlined(found.outer, found.before)).toBe(await canon(BEFORE));
    expect(await inlined(found.outer, found.after)).toBe(await canon(AFTER));
  });

  test("narrows an edit that changes how many instructions there are", async () => {
    // One instruction becomes two, so everything after it is renumbered and
    // only the wider window lines up. It is still less than the whole body.
    const before = `define i32 @f(i32 %x) {
entry:
  %h = lshr i32 %x, 4
  %a = mul i32 %h, 2
  %b = add i32 %a, 1
  ret i32 %b
}
`;
    const after = `define i32 @f(i32 %x) {
entry:
  %h = lshr i32 %x, 4
  %a = shl i32 %h, 1
  %c = add i32 %a, 0
  %b = add i32 %c, 1
  ret i32 %b
}
`;
    const found = await narrow(llops, await canon(before), await canon(after));
    if (!found) throw new Error("expected the step to narrow");
    expect(body(found.before)).toHaveLength(3);
    expect(body(found.after)).toHaveLength(4);
    expect(await inlined(found.outer, found.before)).toBe(await canon(before));
    expect(await inlined(found.outer, found.after)).toBe(await canon(after));
  });

  test("says nothing when the first instruction is the one that changed", async () => {
    // Nothing is shared at either end, so the window is the body and the
    // whole function is the only question there is.
    const before = `define i32 @f(i32 %x) {
entry:
  %a = mul i32 %x, 2
  ret i32 %a
}
`;
    const after = before.replace("mul i32 %x, 2", "shl i32 %x, 1");
    expect(await narrow(llops, await canon(before), await canon(after))).toBeUndefined();
  });

  test("says nothing when the window would read something else", async () => {
    // The two windows are the same shape in the same place, and still not one
    // question: the edit changed which value flows in, so the calls disagree
    // and the outers are not the same program. This is the verification doing
    // the work rather than the guess.
    const before = `define i32 @f(i32 %x) {
entry:
  %h = lshr i32 %x, 4
  %g = shl i32 %x, 4
  %a = add i32 %h, 1
  ret i32 %a
}
`;
    const after = before.replace("add i32 %h, 1", "add i32 %g, 1");
    expect(await narrow(llops, await canon(before), await canon(after))).toBeUndefined();
  });

  test("says nothing about a body with nothing but a return", async () => {
    const before = "define i32 @f(i32 %x) {\nentry:\n  ret i32 %x\n}\n";
    const after = "define i32 @f(i32 %x) {\nentry:\n  ret i32 0\n}\n";
    expect(await narrow(llops, before, after)).toBeUndefined();
  });
});
