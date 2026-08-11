// Confining the sandbox tools to the scratch directory.
//
// bash, read, write and grep are the only way a model touches the sandbox,
// and the whole point of them is that the touching goes no further than the
// run's scratch directory: the run's record, Pi's credentials and the
// repository all live outside it. What is tested here is the door, one
// refusal at a time: a path that resolves outside is refused, a symlink
// planted inside cannot smuggle one out, and the shell cannot write anywhere
// but the scratch directory.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxTools } from "../agent/tools/index.ts";

let dir: string;
let scratch: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "alive-next-sandbox-"));
  scratch = join(dir, "scratch");
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Tool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<{ content: { type: string; text: string }[] }>;
}

interface Sandbox {
  read: Tool;
  write: Tool;
  grep: Tool;
  ls: Tool;
  find: Tool;
  bash: Tool;
}

/** The four sandbox tools, confined to `work`. */
function sandbox(work: string, toolchain?: string): Sandbox {
  const found: Partial<Sandbox> = {};
  for (const tool of createSandboxTools(work, toolchain)) {
    found[tool.name as keyof Sandbox] = tool as unknown as Tool;
  }
  return found as Sandbox;
}

function call(tool: Tool, params: Record<string, unknown>): Promise<string> {
  return tool
    .execute("c1", params, undefined, undefined)
    .then((result) => result.content.map((part) => part.text).join(""));
}

describe("read", () => {
  test("serves what the scratch holds", async () => {
    writeFileSync(join(scratch, "probe.ll"), "hello probe");
    await expect(call(sandbox(scratch).read, { path: "probe.ll" })).resolves.toContain(
      "hello probe",
    );
  });

  test("refuses a path that resolves outside", async () => {
    const sentinel = join(scratch, "..", "trajectory.jsonl");
    writeFileSync(sentinel, "a run's private record");
    await expect(call(sandbox(scratch).read, { path: sentinel })).rejects.toThrow(
      /outside the workdir directory/,
    );
    await expect(call(sandbox(scratch).read, { path: "/etc/hostname" })).rejects.toThrow(
      /outside the workdir directory/,
    );
  });

  test("a symlink planted inside cannot smuggle a read out", async () => {
    symlinkSync(scratch, join(scratch, "loop"));
    symlinkSync("/etc", join(scratch, "etc"));
    await expect(call(sandbox(scratch).read, { path: "etc/hostname" })).rejects.toThrow(
      /outside the workdir directory/,
    );
  });
});

describe("write", () => {
  test("lands where it is asked, creating parents", async () => {
    await call(sandbox(scratch).write, { path: "probes/one.ll", content: "probe" });
    expect(readFileSync(join(scratch, "probes", "one.ll"), "utf8")).toBe("probe");
  });

  test("refuses a path that resolves outside", async () => {
    await expect(
      call(sandbox(scratch).write, { path: "../escape.ll", content: "x" }),
    ).rejects.toThrow(/outside the workdir directory/);
    await expect(call(sandbox(scratch).write, { path: dir, content: "x" })).rejects.toThrow(
      /outside the workdir directory/,
    );
    expect(existsSync(join(dir, "escape.ll"))).toBe(false);
  });

  test("a symlink planted inside cannot smuggle a write out", async () => {
    const outside = join(dir, "elsewhere");
    mkdirSync(outside);
    symlinkSync(outside, join(scratch, "there"));
    await expect(
      call(sandbox(scratch).write, { path: "there/pwned.ll", content: "x" }),
    ).rejects.toThrow(/outside the workdir directory/);
    expect(existsSync(join(outside, "pwned.ll"))).toBe(false);
  });
});

describe("grep", () => {
  test("serves searches inside the scratch", async () => {
    writeFileSync(join(scratch, "a.ll"), "define i32 @a() { ret i32 1 }");
    await expect(call(sandbox(scratch).grep, { pattern: "define" })).resolves.toContain("a.ll");
  });

  test("refuses a search root outside", async () => {
    await expect(call(sandbox(scratch).grep, { pattern: "x", path: "/etc" })).rejects.toThrow(
      /outside the workdir directory/,
    );
    await expect(call(sandbox(scratch).grep, { pattern: "x", path: ".." })).rejects.toThrow(
      /outside the workdir directory/,
    );
  });
});

describe("ls", () => {
  test("serves the scratch directory", async () => {
    mkdirSync(join(scratch, "probes"));
    writeFileSync(join(scratch, "probes", "one.ll"), "probe");
    await expect(call(sandbox(scratch).ls, { path: "probes" })).resolves.toContain("one.ll");
    await expect(call(sandbox(scratch).ls, {})).resolves.toContain("probes");
  });

  test("refuses a directory that resolves outside", async () => {
    await expect(call(sandbox(scratch).ls, { path: "/etc" })).rejects.toThrow(
      /outside the workdir directory/,
    );
    await expect(call(sandbox(scratch).ls, { path: ".." })).rejects.toThrow(
      /outside the workdir directory/,
    );
  });
});

describe("find", () => {
  test("serves searches inside the scratch", async () => {
    mkdirSync(join(scratch, "probes"));
    writeFileSync(join(scratch, "probes", "one.ll"), "probe");
    await expect(call(sandbox(scratch).find, { pattern: "*.ll" })).resolves.toContain(
      "probes/one.ll",
    );
  });

  test("refuses a search root outside", async () => {
    await expect(call(sandbox(scratch).find, { pattern: "x", path: "/etc" })).rejects.toThrow(
      /outside the workdir directory/,
    );
    await expect(call(sandbox(scratch).find, { pattern: "x", path: ".." })).rejects.toThrow(
      /outside the workdir directory/,
    );
  });
});

// The shell's sandbox needs bubblewrap, socat and ripgrep on Linux, which is
// what the sandbox runtime itself checks; without them the shell cannot exist
// and the tests that need it say so rather than fail.
const hasSandbox = ["bwrap", "socat", "rg"].every(
  (tool) => spawnSync("which", [tool]).status === 0,
);
const sandboxed = hasSandbox ? describe : describe.skip;

// The shell tests share one run directory: the sandbox runtime holds whatever
// configuration it first initialized for the whole process, so a per-test
// directory would leave every test after the first with a sandbox confined to
// another run's.
sandboxed("bash", () => {
  const run = join(tmpdir(), "shared-run");
  const scratch = join(run, "scratch");

  beforeEach(() => {
    rmSync(run, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
  });

  const tools = () => sandbox(scratch, join(run, "nominal-toolchain"));

  test("writes inside the scratch", async () => {
    await call(tools().bash, { command: "echo built > built.txt" });
    expect(readFileSync(join(scratch, "built.txt"), "utf8")).toBe("built\n");
  });

  test("cannot write outside the scratch", async () => {
    await expect(
      call(tools().bash, { command: "touch /etc/alive-next-forbidden-marker" }),
    ).rejects.toThrow(/exited with code/);
    expect(existsSync("/etc/alive-next-forbidden-marker")).toBe(false);
  });

  test("cannot read the run's record", async () => {
    writeFileSync(join(run, "trajectory.jsonl"), "private");
    await expect(
      call(tools().bash, { command: `cat ${join(run, "trajectory.jsonl")}` }),
    ).rejects.toThrow(/exited with code/);
  });

  test("carries the host's environment", async () => {
    process.env.ALIVE_MARKER = "visible-here";
    try {
      await expect(call(tools().bash, { command: "echo $ALIVE_MARKER" })).resolves.toContain(
        "visible-here",
      );
    } finally {
      delete process.env.ALIVE_MARKER;
    }
  });

  test("the system's tmp directory is writable", async () => {
    const marker = "/tmp/alive-sandbox-marker";
    rmSync(marker, { force: true });
    try {
      await call(tools().bash, { command: `echo tmp > ${marker}` });
      expect(readFileSync(marker, "utf8")).toBe("tmp\n");
    } finally {
      rmSync(marker, { force: true });
    }
  });
});
