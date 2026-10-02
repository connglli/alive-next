// Tests peeling a region that no window can hold into a goal of its own.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { peel } from "../simple/peel.ts";
import { regions } from "../simple/regions.ts";
import { bodies } from "../simple/windows.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-peel-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function start(src: string, tgt: string) {
  const unknown: CheckResult = {
    outcome: "unknown",
    detail: "",
    invocation: { binary: "stub", flags: [], timeoutMs: 0 },
    stdout: "",
    ms: 0,
  };
  return Session.start({
    dir: join(dir, "run"),
    src,
    tgt,
    llops,
    checker: { check: async () => unknown },
    interp: {} as Interpreter,
    rewriter: {} as Llrwt,
  });
}

/** How many regions are left in each goal. */
async function left(session: Session, goals: string[]) {
  return Promise.all(
    goals.map(async (gid) => regions(...(await bodies(session, llops, gid))).length),
  );
}

describe.skipIf(!built)("peel", () => {
  test("a region that ends the body is cut at its head", async () => {
    const src = `define i32 @f(i32 %x, i32 %y) {
entry:
  %a = mul i32 %x, %y
  %b = add i32 %a, 1
  %c = sub i32 %b, %x
  ret i32 %c
}
`;
    const session = await start(
      src,
      src.replace("  %c = sub i32 %b, %x\n  ret i32 %c", "  ret i32 %b"),
    );
    const [region] = regions(...(await bodies(session, llops, "g1")));
    if (!region) throw new Error("expected a region");
    expect(region.window).toBe(false);
    const goals = await peel(session, llops, "g1", region);
    expect(await left(session, goals)).toEqual([0, 1]);
  });

  test("a phi with code after it is cut after it, then at its block", async () => {
    const src = `define i32 @f(i1 %c, i32 %x) {
entry:
  br i1 %c, label %t, label %e

t:
  %a = add i32 %x, 1
  br label %j

e:
  %b = sub i32 %x, 1
  br label %j

j:
  %p = phi i32 [ %a, %t ], [ %b, %e ]
  %r = mul i32 %p, 3
  ret i32 %r
}
`;
    const session = await start(src, src.replace("[ %b, %e ]", "[ %x, %e ]"));
    const [region] = regions(...(await bodies(session, llops, "g1")));
    if (!region) throw new Error("expected a region");
    const goals = await peel(session, llops, "g1", region);
    // Detaching the phi's block turns the phi into the callee's parameter, so
    // the difference moves to the value the outer passes it.
    expect(await left(session, goals)).toEqual([1, 0, 0]);
  });
});
