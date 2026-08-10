// The alive-tv driver.
//
// alive2 takes an hour of LLVM to build, so the parsing is tested against the
// output alive-tv actually prints, captured here, and the spawning is tested
// against a stub that replays it. What the tests encode is the contract read
// out of alive2's own sources: the summary block says how a check went, and
// the exit code does not, since alive-tv exits 0 for an incorrect
// transformation and non-zero only for its own errors.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AliveTv, AliveTvCrash, read } from "../core/drivers/alive2.ts";

const CORRECT = `
----------------------------------------
define i32 @f(i32 %x) {
...
}
=>
define i32 @f(i32 %x) {
...
}
Transformation seems to be correct!

Summary:
  1 correct transformations
  0 incorrect transformations
  0 failed-to-prove transformations
  0 Alive2 errors
`;

const INCORRECT = `
----------------------------------------
Transformation doesn't verify!

ERROR: Value mismatch

Example:
i32 %x = #x00000001 (1)

Source value: #x00000002 (2)
Target value: #x00000003 (3)

Summary:
  0 correct transformations
  1 incorrect transformations
  0 failed-to-prove transformations
  0 Alive2 errors
`;

const TIMED_OUT = `
----------------------------------------
ERROR: Timeout

Summary:
  0 correct transformations
  0 incorrect transformations
  1 failed-to-prove transformations
  0 Alive2 errors
`;

const BROKEN = `
ERROR: Could not translate 'f' to Alive IR

Summary:
  0 correct transformations
  0 incorrect transformations
  0 failed-to-prove transformations
  1 Alive2 errors
`;

describe("reading what alive-tv printed", () => {
  test("a correct transformation", () => {
    const result = read(CORRECT);
    expect(result.outcome).toBe("correct");
    expect(result.summary).toEqual({ correct: 1, incorrect: 0, failed: 0, errors: 0 });
  });

  test("an incorrect one, keeping the counterexample", () => {
    const result = read(INCORRECT);
    expect(result.outcome).toBe("incorrect");
    expect(result.detail).toContain("Example:");
    expect(result.detail).toContain("Source value");
    // The summary is not part of the reason the agent reads.
    expect(result.detail).not.toContain("Summary:");
  });

  test("a check that did not settle", () => {
    const result = read(TIMED_OUT);
    expect(result.outcome).toBe("unknown");
    expect(result.detail).toContain("Timeout");
  });

  test("an alive2 error", () => {
    expect(read(BROKEN).outcome).toBe("error");
  });

  test("output with no summary at all", () => {
    const result = read("Could not read bitcode from 'src.ll'\n");
    expect(result.outcome).toBe("error");
    expect(result.detail).toContain("Could not read bitcode");
    expect(result.summary).toBeUndefined();
  });

  test("a run that compared nothing", () => {
    const result = read(`Summary:
  0 correct transformations
  0 incorrect transformations
  0 failed-to-prove transformations
  0 Alive2 errors
`);
    expect(result.outcome).toBe("error");
    expect(result.detail).toContain("compared no functions");
  });

  test("falls back to stderr when stdout is empty", () => {
    expect(read("", "alive-tv: symbol lookup error").detail).toContain("symbol lookup error");
  });
});

/** A stand-in for alive-tv that prints what it is told and exits how it likes. */
function stub(output: string, exitCode = 0): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "alive-next-stub-"));
  const path = join(dir, "alive-tv");
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho "$@" > "${join(dir, "argv")}"\ncat <<'OUT'\n${output}\nOUT\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return { dir, path };
}

describe("running alive-tv", () => {
  test("passes the two files and the timeout, and records what it ran", async () => {
    // Exit 1 stands for an alive2 error; the summary says the check was
    // correct, and the summary is what decides.
    const { dir, path } = stub(CORRECT);
    try {
      const result = await new AliveTv(path).check("define void @f() {}", "define void @f() {}", {
        timeoutMs: 5000,
      });
      expect(result.outcome).toBe("correct");
      expect(result.invocation).toEqual({
        binary: path,
        flags: ["--smt-to=5000"],
        timeoutMs: 5000,
      });
      expect(result.ms).toBeGreaterThanOrEqual(0);

      const argv = await Bun.file(join(dir, "argv")).text();
      expect(argv).toContain("src.ll");
      expect(argv).toContain("tgt.ll");
      expect(argv).toContain("--smt-to=5000");
      // src comes first, because alive-tv asks whether the second refines it.
      expect(argv.indexOf("src.ll")).toBeLessThan(argv.indexOf("tgt.ll"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("believes the summary over the exit code", async () => {
    const { dir, path } = stub(INCORRECT, 0);
    try {
      const result = await new AliveTv(path).check("a", "b");
      expect(result.outcome).toBe("incorrect");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("takes extra flags from the caller", async () => {
    const { dir, path } = stub(CORRECT);
    try {
      const result = await new AliveTv(path).check("a", "b", {
        timeoutMs: 1000,
        flags: ["--tgt-unroll=2"],
      });
      expect(result.invocation.flags).toEqual(["--smt-to=1000", "--tgt-unroll=2"]);
      expect(await Bun.file(join(dir, "argv")).text()).toContain("--tgt-unroll=2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when the binary is not there", async () => {
    // A missing checker is a broken installation, not a goal that failed to
    // prove: reporting it as an outcome would let a run say "unknown" when
    // nothing was checked at all.
    const missing = new AliveTv(join(tmpdir(), "no-such-alive-tv"));
    await expect(missing.check("a", "b")).rejects.toBeInstanceOf(AliveTvCrash);
  });
});
