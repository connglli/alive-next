// Reading a toolchain directory.
//
// The failure worth testing is the quiet one: three binaries that run, and
// disagree about what a module means. So these build directories by hand,
// with scripts that answer like the real tools do.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LAYOUT, llvmVersion, Toolchain, ToolchainError } from "../core/toolchain.ts";
import { toolchain } from "./toolchain-under-test.ts";

/** A toolchain directory whose binaries say what the argument says. */
function fake(versions: Record<string, string | null>): string {
  const dir = mkdtempSync(join(tmpdir(), "alive-next-tc-"));
  for (const [name, line] of Object.entries(versions)) {
    if (line === null) continue;
    const path = join(dir, LAYOUT[name as keyof typeof LAYOUT].at);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `#!/bin/sh\necho '${line}'\n`, "utf8");
    chmodSync(path, 0o755);
  }
  return dir;
}

const AGREED = {
  llops: "llops 0.1.0 (LLVM 22.1.0)",
  "alive-tv": "LLVM version 22.1.0",
  llubi: "LLVM version 22.1.0",
};

describe("reading a version banner", () => {
  test("takes the release however the tool words it", () => {
    expect(llvmVersion("llops 0.1.0 (LLVM 22.1.0)")).toBe("22.1.0");
    expect(llvmVersion("  LLVM version 22.1.0\n  Optimized build.")).toBe("22.1.0");
    expect(llvmVersion("nothing to say")).toBeUndefined();
  });
});

describe("insisting on a toolchain", () => {
  test("passes when every tool carries the same LLVM", async () => {
    const dir = fake(AGREED);
    try {
      const report = await new Toolchain(dir).insist();
      expect(report.tools.llops?.llvm).toBe("22.1.0");
      expect(report.tools.llubi?.llvm).toBe("22.1.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a mixed set, naming what each one carries", async () => {
    // The failure this prevents: llops printing IR alive-tv cannot parse, which
    // reads as a proof going wrong rather than an install being wrong.
    const dir = fake({ ...AGREED, llops: "llops 0.1.0 (LLVM 20.1.2)" });
    try {
      const attempt = new Toolchain(dir).insist();
      await expect(attempt).rejects.toThrow(ToolchainError);
      await expect(attempt).rejects.toThrow(/mixes LLVM versions/);
      await expect(attempt).rejects.toThrow(/llops: LLVM 20\.1\.2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses one that was never built, and says how to build it", async () => {
    const dir = fake({ ...AGREED, llubi: null });
    try {
      const attempt = new Toolchain(dir).insist();
      await expect(attempt).rejects.toThrow(/is not built/);
      await expect(attempt).rejects.toThrow(/make install-deps/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("has no stamp when nobody wrote one", () => {
    const dir = fake(AGREED);
    try {
      expect(new Toolchain(dir).stamp()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the toolchain this suite runs against", () => {
  test("is one build, if it is there at all", async () => {
    if (!toolchain.has("llops")) return;
    const report = await toolchain.insist();
    expect(new Set(Object.values(report.tools).map((tool) => tool.llvm)).size).toBe(1);
  });
});
