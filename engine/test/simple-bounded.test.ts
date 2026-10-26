// Loops before the search: those the tgt no longer has peeled away, the rest rotated.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "../core/drivers/alive2.ts";
import { Llops } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import { Session } from "../core/session.ts";
import type { Interpreter } from "../core/state/counterexamples.ts";
import { bounded } from "../examples/bounded.ts";
import { outermost, peelBounded } from "../simple/bounded.ts";
import { rotate } from "../simple/loops.ts";
import { headers, loopOf, predecessors, successors } from "../simple/regions.ts";
import { bodies } from "../simple/windows.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const built = await llops
  .version()
  .then(() => true)
  .catch(() => false);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-bounded-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A session whose checker decides nothing, so only steps `reshaped` certifies land. */
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

const NESTED = `define i32 @f() {
entry:
  br label %outer

outer:
  %i = phi i32 [ 0, %entry ], [ %i.next, %outer.latch ]
  br label %inner

inner:
  %j = phi i32 [ 0, %outer ], [ %j.next, %inner ]
  %j.next = add nuw nsw i32 %j, 1
  %more.j = icmp ult i32 %j.next, 3
  br i1 %more.j, label %inner, label %outer.latch

outer.latch:
  %i.next = add nuw nsw i32 %i, 1
  %more.i = icmp ult i32 %i.next, 5
  br i1 %more.i, label %outer, label %exit

exit:
  ret i32 %i
}
`;

describe.skipIf(!built)("bounded loops", () => {
  test("a nest counts by its outer loop", async () => {
    const session = await start(NESTED, NESTED);
    const [src] = await bodies(session, llops, "g1");
    expect(headers(src)).toHaveLength(2);
    expect(outermost(src)).toEqual(headers(src).slice(0, 1));
  });

  test("a loop the tgt computes outright is peeled and cut away", async () => {
    const session = await start(bounded.src, bounded.tgt);
    const left = await peelBounded(session, llops, "g1");
    expect(left).not.toBe("g1");
    const [src] = await bodies(session, llops, left);
    expect(headers(src)).toEqual([]);
    const callee = [...session.tree.goals.values()].find((goal) => goal.role === "callee");
    expect(callee?.status).toBe("proved");
  });

  test("a loop whose header exits is rotated", async () => {
    const session = await start(bounded.src, bounded.src);
    await rotate(session, llops, "g1");
    const [src] = await bodies(session, llops, "g1");
    const [header] = headers(src);
    if (!header) throw new Error("expected a loop");
    const inside = loopOf(successors(src), predecessors(src), header);
    expect(
      successors(src)
        .get(header)
        ?.every((to) => inside.has(to)),
    ).toBe(true);
  });

  test("a loop no constant bounds stays", async () => {
    const src = bounded.src.replace("icmp slt i32 %iv, 4", "icmp slt i32 %iv, %x");
    const session = await start(src, bounded.tgt);
    expect(await peelBounded(session, llops, "g1")).toBe("g1");
  });
});
