// The llops driver, against the real binary.
//
// llops is ours and answers in milliseconds, so there is nothing to gain from
// a stub: these tests run the thing the agent will run. They skip when it is
// not built, which keeps the suite green on a machine without LLVM.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot } from "../core/config.ts";
import { Llops, LlopsCrash } from "../core/drivers/llops.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

const F = `define i32 @f(i32 %x, i32 %y) {
entry:
  %m = mul i32 %x, %y
  %s = add i32 %m, %x
  ret i32 %s
}
`;

describe.skipIf(!built)("llops", () => {
  test("reports its version", async () => {
    expect(await llops.version()).toMatch(/^llops \d/);
  });

  test("validates a v1 program", async () => {
    const result = await llops.validate(F);
    if (!result.ok) throw new Error(result.message);
    expect(result.conforms).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  test("reports why a program does not conform", async () => {
    const twoBlocks = `define i32 @f(i32 %x) {
entry:
  br label %next

next:
  ret i32 %x
}
`;
    const result = await llops.validate(twoBlocks);
    if (!result.ok) throw new Error(result.message);
    expect(result.conforms).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("not_straightline");
  });

  test("canonicalizes, and does it idempotently", async () => {
    const once = await llops.canon(F);
    if (!once.ok) throw new Error(once.message);
    expect(once.module).toContain("%0");
    const twice = await llops.canon(once.module);
    if (!twice.ok) throw new Error(twice.message);
    expect(twice.module).toBe(once.module);
  });

  test("edits by any of the reference forms", async () => {
    const canonical = await llops.canon(F);
    if (!canonical.ok) throw new Error(canonical.message);

    const bySlot = await llops.edit(canonical.module, { op: "commute", v: "%2" });
    expect(bySlot.ok).toBe(true);

    const byName = await llops.edit(F, { op: "commute", v: "%m" });
    expect(byName.ok).toBe(true);

    const byIndex = await llops.edit(F, { op: "erase", v: "#0" });
    expect(byIndex.ok).toBe(false);
    if (byIndex.ok) throw new Error("erasing a used value should be refused");
    expect(byIndex.code).toBe("used");
  });

  test("hands a refusal back as a code, not an exception", async () => {
    const result = await llops.edit(F, { op: "commute", v: "%nope" });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("not_found");
    expect(result.message).toContain("commute");
  });

  test("puts a flag on and takes one off", async () => {
    const nuw = `define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 1
  ret i32 %a
}
`;
    const on = await llops.edit(nuw, { op: "flags", v: "%a", flags: { nuw: true } });
    if (!on.ok) throw new Error(on.message);
    expect(on.module).toContain("add nuw");

    const off = await llops.edit(on.module, { op: "flags", v: "%a", flags: { nuw: false } });
    if (!off.ok) throw new Error(off.message);
    expect(off.module).toContain("add i32");
    expect(off.module).not.toContain("add nuw");
  });

  test("refuses a flag the instruction cannot carry", async () => {
    const result = await llops.edit(F, { op: "flags", v: "%m", flags: { exact: true } });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("invalid");
  });

  test("reports a parse error as a refusal too", async () => {
    const result = await llops.canon("not ir at all");
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("parse_error");
  });

  test("outlines a side and inlines it back", async () => {
    const out = await llops.outlineSrc(F, "%s", "g");
    if (!out.ok) throw new Error(out.message);
    expect(out.params).toEqual([
      { param: "%p0", type: "i32", live: "%m" },
      { param: "%p1", type: "i32", live: "%x" },
    ]);

    const back = await llops.inline(out.outer, out.callee, "g");
    if (!back.ok) throw new Error(back.message);
    const original = await llops.canon(F);
    const roundtrip = await llops.canon(back.module);
    if (!original.ok || !roundtrip.ok) throw new Error("canon refused");
    expect(roundtrip.module).toBe(original.module);
  });

  test("outlines the tgt side against the src signature", async () => {
    const src = await llops.outlineSrc(F, "%s", "g");
    if (!src.ok) throw new Error(src.message);
    const tgt = await llops.outlineTgt(F, "%s", "g", src.params, { "%m": "%m", "%x": "%x" });
    if (!tgt.ok) throw new Error(tgt.message);
    expect(tgt.params).toEqual(src.params);
  });

  test("analyzes known bits at a point", async () => {
    const masked = `define i32 @f(i32 %x) {
entry:
  %a = and i32 %x, 255
  %b = add i32 %a, 1
  ret i32 %b
}
`;
    const result = await llops.analyze(masked, "knownbits", "%b");
    if (!result.ok) throw new Error(result.message);
    expect(result.point).toBe("%b");
    const fact = result.facts.find((candidate) => candidate.value === "%a");
    expect(fact?.unknown_bits).toBe("0xFF");
  });

  test("analyzes what is defined, over every type", async () => {
    const module = `define i32 @f(i32 noundef %n, i32 %m) {
entry:
  %a = and i32 %n, 255
  %b = add nsw i32 %n, 1
  ret i32 %a
}
`;
    const result = await llops.analyze(module, "defined");
    if (!result.ok) throw new Error(result.message);
    const facts = new Map(result.facts.map((fact) => [fact.value, fact]));
    expect(facts.get("%a")?.noundef).toBe(true);
    expect(facts.get("%m")?.noundef).toBe(false);
    // The halves say which fix a value needs; this one only wants its flag off.
    expect(facts.get("%b")?.noundef).toBe(false);
    expect(facts.get("%b")?.not_undef).toBe(true);
  });

  test("defaults the analysis point to the end of the body", async () => {
    const result = await llops.analyze(F, "ranges");
    if (!result.ok) throw new Error(result.message);
    expect(result.point).toBe("#2");
  });
});

describe("a binary that is not there", () => {
  test("throws rather than answering", async () => {
    const missing = new Llops(join(repoRoot(), "no", "such", "llops"));
    await expect(missing.canon(F)).rejects.toBeInstanceOf(LlopsCrash);
  });
});
