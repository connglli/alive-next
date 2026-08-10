// The llubi driver.
//
// The traces below are what the interpreter actually printed, so the parsing
// is tested against its real output. The runs are tested against the real
// binary too, and skip when it is not installed; the last of them goes through
// llops as well, which is the path a counterexample replay takes.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { repoRoot } from "../core/config.ts";
import { Llops } from "../core/drivers/llops.ts";
import { Llubi, LlubiCrash, read } from "../core/drivers/llubi.ts";
import { toolchain } from "./toolchain-under-test.ts";

const RETURNED = `
Entering function main
  i32 %0 = i32 0
  ptr %1 = Ptr 0[@null] captures(address, provenance) RW
  %buf1 = alloca [4 x i8], align 4 -> Ptr 3072[%ptr %buf1] captures(address, provenance) RW
  store [4 x i8] c"#\\00\\00\\00", ptr %buf1, align 1
  %2 = call i32 @f(i32 7, ptr %buf1)

Entering function f
  ret i32 %s
Exiting function f
 -> i32 42
  %obs.result = load i32, ptr %result.slot, align 4 -> i32 42
  %obs.mem.1.0 = load i8, ptr %3, align 1 -> i8 42
  %obs.mem.1.1 = load i8, ptr %4, align 1 -> i8 0
  ret i32 0
Exiting function main
`;

const UB = `
Entering function main
  %p = inttoptr i64 0 to ptr -> Ptr 0[@null] captures(address, provenance) RW
  %v = load i32, ptr %p, align 4
UB triggered: Out of bound mem op, bound = 0, access range = [0, 4)
Exited with immediate UB.
Stacktrace:
    %v = load i32, ptr %p, align 4 at @main
`;

const NO_MAIN = "Cannot find entry function `main`\n";

describe("reading what llubi printed", () => {
  test("a run that returned, with its observations", () => {
    const result = read(RETURNED);
    expect(result.outcome).toBe("returned");
    expect(result.observations).toEqual({
      "%obs.result": "i32 42",
      "%obs.mem.1.0": "i8 42",
      "%obs.mem.1.1": "i8 0",
    });
  });

  test("UB, with the reason and where it happened", () => {
    const result = read(UB);
    expect(result.outcome).toBe("ub");
    expect(result.reason).toBe("Out of bound mem op, bound = 0, access range = [0, 4)");
    expect(result.at).toBe("%v = load i32, ptr %p, align 4 at @main");
  });

  test("a module llubi would not run", () => {
    const result = read(NO_MAIN);
    expect(result.outcome).toBe("error");
    expect(result.reason).toContain("Cannot find entry function");
  });

  test("a budget it ran out of, which it says without a line of its own", () => {
    const result = read(
      "\nEntering function main\n  %a = add i32 1, 1 -> i32 2Exceed maximum steps",
    );
    expect(result.outcome).toBe("error");
    expect(result.reason).toBe("Exceed maximum steps");
  });

  test("keeps what it observed even when the run then hit UB", () => {
    const result = read(`${RETURNED.replace("Exiting function main", "")}\nUB triggered: nope\n`);
    expect(result.outcome).toBe("ub");
    expect(result.observations["%obs.result"]).toBe("i32 42");
  });
});

const llubi = new Llubi(toolchain.path("llubi"));
const installed = await llubi
  .version()
  .then((line) => line.length > 0)
  .catch(() => false);

const llops = new Llops(toolchain.path("llops"));
const llopsBuilt = await llops
  .version()
  .then(() => true)
  .catch(() => false);

describe.skipIf(!installed)("running llubi", () => {
  test("runs a module given on stdin", async () => {
    const result = await llubi.run(`define i32 @main(i32 %argc, ptr %argv) {
entry:
  ret i32 7
}
`);
    expect(result.outcome).toBe("returned");
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  test("reports UB rather than a return", async () => {
    const result = await llubi.run(`define i32 @main(i32 %argc, ptr %argv) {
entry:
  %p = inttoptr i64 0 to ptr
  %v = load i32, ptr %p, align 4
  ret i32 %v
}
`);
    expect(result.outcome).toBe("ub");
    expect(result.reason).toContain("Out of bound");
  });

  test("stops at the budget it is given", async () => {
    const result = await llubi.run(
      `define i32 @main(i32 %argc, ptr %argv) {
entry:
  %a = add i32 1, 1
  %b = add i32 %a, 1
  ret i32 %b
}
`,
      { maxSteps: 1 },
    );
    expect(result.outcome).toBe("error");
    expect(result.reason).toContain("Exceed maximum steps");
  });

  test("throws when the binary is not there", async () => {
    const missing = new Llubi(join(repoRoot(), "no", "such", "llubi"));
    await expect(missing.run("define i32 @main() { ret i32 0 }")).rejects.toBeInstanceOf(
      LlubiCrash,
    );
  });
});

describe.skipIf(!installed || !llopsBuilt)("a harness from llops, run by llubi", () => {
  test("reports the return value and the final memory", async () => {
    const program = `define i32 @f(i32 %x, ptr %p) {
entry:
  %v = load i32, ptr %p, align 4
  %s = add i32 %v, %x
  store i32 %s, ptr %p, align 4
  ret i32 %s
}
`;
    const harness = await llops.harness(program, "f", [
      { kind: "int", value: "7" },
      { kind: "bytes", bytes: [35, 0, 0, 0], align: 4 },
    ]);
    if (!harness.ok) throw new Error(harness.message);

    const result = await llubi.run(harness.module);
    expect(result.outcome).toBe("returned");
    // 7 + 35, returned and left behind in the buffer.
    expect(result.observations["%obs.result"]).toBe("i32 42");
    expect(result.observations["%obs.mem.1.0"]).toBe("i8 42");
    expect(result.observations["%obs.mem.1.3"]).toBe("i8 0");
    expect(Object.keys(result.observations)).toEqual(harness.observations);
  });
});
