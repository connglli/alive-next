// The candidates a run breaks: llubi's trace read at each visit of a header,
// and the facts dropped before Houdini asks alive2 about them.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckResult } from "../core/drivers/alive2.ts";
import { Llops, type OutlineParam } from "../core/drivers/llops.ts";
import type { Llrwt } from "../core/drivers/llrwt.ts";
import { Llubi } from "../core/drivers/llubi.ts";
import { Session } from "../core/session.ts";
import { nestedinvariant } from "../examples/nestedinvariant.ts";
import { unbrokenByRuns, visitsOf } from "../simple/runs.ts";
import { toolchain } from "./toolchain-under-test.ts";

const llops = new Llops(toolchain.path("llops"));
const llubi = new Llubi(toolchain.path("llubi"));
const running = await llubi
  .version()
  .then((line) => line.length > 0)
  .catch(() => false);

/** A checker the runs never need, since they ask alive2 nothing. */
const unasked = {
  check: async (): Promise<CheckResult> => {
    throw new Error("a run asks alive2 nothing");
  },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-runs-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function start(src: string): Promise<Session> {
  return Session.start({
    dir: join(dir, "run"),
    src,
    tgt: src,
    llops,
    checker: unasked,
    interp: llubi,
    rewriter: {} as Llrwt,
  });
}

/** A cut's parameter that stands for `live`. */
const param = (live: string, type: string): OutlineParam => ({ param: live, type, live });

// A loop at %head that calls @g on every iteration, as llubi traces it for n = 2.
const TRACE = `Entering function main
  %2 = call i32 @f(i32 2)

Entering function f
  i32 %n = i32 2
  br label %head jump to %head
    phi i32 %i -> i32 0
  %w = call i32 @g(i32 %i)

Entering function g
  i32 %i = i32 99
  ret i32 %i
Exiting function g
 -> i32 1
  %c = icmp slt i32 %i, %n -> T
  br i1 %c, label %head, label %exit jump to %head
    phi i32 %i -> i32 1
  %w = call i32 @g(i32 %i)

Entering function g
  ret i32 %i
Exiting function g
 -> poison
  br i1 %c, label %head, label %exit jump to %exit
Exiting function f
 -> i32 2`;

describe("reading a run", () => {
  test("a visit of the header holds its phis and the values from before the loop", () => {
    const visits = visitsOf(TRACE, "f", "%head", [param("%i", "i32"), param("%n", "i32")]);
    expect(visits).toEqual([
      [
        { type: "i32", value: 0n },
        { type: "i32", value: 2n },
      ],
      [
        { type: "i32", value: 1n },
        { type: "i32", value: 2n },
      ],
    ]);
  });

  test("a call's result is read after the frame it called, which is not the entry's", () => {
    const visits = visitsOf(TRACE, "f", "%head", [param("%w", "i32")]);
    // At the second visit %w holds the first call's result; g's own %i never leaks.
    expect(visits[1]).toEqual([{ type: "i32", value: 1n }]);
  });
});

describe.skipIf(!running)("dropping the candidates a run breaks", () => {
  test("drops i <=u m, which an iteration breaks as soon as i passes m", async () => {
    const session = await start(nestedinvariant.src);
    // At the outer header, i is %2 and m is %1.
    const params = [param("%2", "i32"), param("%3", "i64"), param("%0", "i32"), param("%1", "i32")];
    const candidates = {
      param_attrs: { 0: { noundef: true } },
      predicates: [
        { op: "sge" as const, lhs: "!0", rhs: 0 },
        { op: "ule" as const, lhs: "!0", rhs: "!3" },
      ],
    };
    const kept = await unbrokenByRuns(session, llops, "g1", "%bb1", params, candidates);
    expect(kept).toEqual({
      param_attrs: { 0: { noundef: true } },
      predicates: [{ op: "sge", lhs: "!0", rhs: 0 }],
    });
  });

  test("keeps a fact only runs that end in undefined behavior break", async () => {
    // i <=u 2 fails only where n > 2, and there the function's end is unreachable.
    const src = `define i32 @f(i32 noundef %n) {
entry:
  br label %head

head:
  %i = phi i32 [ 0, %entry ], [ %i.next, %head ]
  %i.next = add i32 %i, 1
  %c = icmp slt i32 %i.next, %n
  br i1 %c, label %head, label %exit

exit:
  %big = icmp sgt i32 %n, 2
  br i1 %big, label %never, label %done

never:
  unreachable

done:
  ret i32 %i
}
`;
    const session = await start(src);
    const params = [param("%1", "i32"), param("%0", "i32")];
    const candidates = {
      predicates: [
        { op: "ule" as const, lhs: "!0", rhs: 2 },
        { op: "eq" as const, lhs: "!0", rhs: 0 },
      ],
    };
    const kept = await unbrokenByRuns(session, llops, "g1", "%bb1", params, candidates);
    expect(kept.predicates).toEqual([{ op: "ule", lhs: "!0", rhs: 2 }]);
  });
});
