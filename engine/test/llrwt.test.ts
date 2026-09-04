// The llrwt driver, against stand-ins, and against the toolchain build itself.
//
// llrwt itself is VeIR's verified rewriter built by depman.sh into the
// toolchain, so unlike the llops tests these run a stub: a bash script that
// records its argv, records the input file it was handed, and prints what it
// is told. What the stub tests pin is the driver's side of the CLI contract:
// which arguments it passes, how it reads stdout, and which exit turns into a
// refusal and which into a broken installation. The last section drives the
// real binary instead, gated on the toolchain having one, which is what pins
// the llrwt side the mapping depends on: the exit codes, the message wording,
// and that success prints afresh rather than echoing.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Llrwt, LlrwtCrash } from "../core/drivers/llrwt.ts";
import { toolchain } from "./toolchain-under-test.ts";

/** A stand-in for llrwt that records argv and its input file, then answers. */
function stub(stdout: string, exitCode = 0, stderr = ""): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "alive-next-llrwt-stub-"));
  const path = join(dir, "llrwt");
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho "$@" > "${join(dir, "argv")}"\n` +
      `if [ -f "\${@: -1}" ]; then cat "\${@: -1}" > "${join(dir, "input")}"; fi\n` +
      `echo "$@" >&2\n` +
      `cat <<'OUT'\n${stdout}\nOUT\n` +
      `cat >&2 <<'ERR'\n${stderr}\nERR\n` +
      `exit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return { dir, path };
}

async function argv(dir: string): Promise<string> {
  return Bun.file(join(dir, "argv")).text();
}

const F = `define i32 @f(i32 %x) {
entry:
  %s = add i32 %x, 0
  ret i32 %s
}
`;

describe("llrwt version", () => {
  test("reports the trimmed version line", async () => {
    const { dir, path } = stub("llrwt 0.1.0 (veir abc123)\n");
    try {
      expect(await new Llrwt(path).version()).toBe("llrwt 0.1.0 (veir abc123)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a version it cannot print is a broken installation", async () => {
    const { dir, path } = stub("", 1, "not really llrwt");
    try {
      await expect(new Llrwt(path).version()).rejects.toBeInstanceOf(LlrwtCrash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("llrwt rules", () => {
  test("lists one rule name per line, before its description", async () => {
    const { dir, path } = stub("addi-zero-to-x - x + 0 => x\nsubi-self-to-zero - x - x => 0\n");
    try {
      expect(await new Llrwt(path).listRules()).toEqual(["addi-zero-to-x", "subi-self-to-zero"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rule table it cannot print is a broken installation", async () => {
    const { dir, path } = stub("", 1, "not really llrwt");
    try {
      await expect(new Llrwt(path).listRules()).rejects.toBeInstanceOf(LlrwtCrash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("llrwt apply", () => {
  test("passes the rules and the input file, and reads stdout back", async () => {
    const out = F.replace("add i32 %x, 0", "add i32 %x, 0 ; folded");
    const { dir, path } = stub(out);
    try {
      const result = await new Llrwt(path).apply(F, ["add_zero", "sub_self"]);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(result.module).toBe(`${out}\n`);
      expect(result.changed).toBe(true);
      expect(result.invocation).toMatchObject({ binary: path, rules: ["add_zero", "sub_self"] });

      const args = await argv(dir);
      expect(args).toContain("--rules add_zero,sub_self");
      expect(args).toContain("--allow-unregistered-dialect");
      await expect(Bun.file(join(dir, "input")).text()).resolves.toBe(F);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unchanged echo reports unchanged", async () => {
    // The stub's heredoc appends one newline, so hand the module over with its
    // trailing newline already stripped: what llrwt prints then equals what it
    // was given.
    const echo = F.trimEnd();
    const { dir, path } = stub(echo);
    try {
      const result = await new Llrwt(path).apply(`${echo}\n`, ["add_zero"]);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(result.changed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown rule is a refusal, on either exit code", async () => {
    for (const exitCode of [1, 2]) {
      const { dir, path } = stub("", exitCode, "Unknown rewrite rule: 'frobnicate'");
      try {
        const result = await new Llrwt(path).apply(F, ["frobnicate"]);
        if (result.ok) throw new Error("expected a refusal");
        expect(result.code).toBe("unknown_rule");
        expect(result.message).toContain("frobnicate");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("names the toolchain translators it ran under", async () => {
    const out = F.replace("add i32 %x, 0", "add i32 %x, 0 ; folded");
    const { dir, path } = stub(out);
    try {
      const llrwt = new Llrwt(path, 30_000, {
        mlirTranslate: "/tc/llvm-project/build/bin/mlir-translate",
        mlirOpt: "/tc/llvm-project/build/bin/mlir-opt",
      });
      const result = await llrwt.apply(F, ["add_zero"]);
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(result.invocation).toMatchObject({
        mlirTranslate: "/tc/llvm-project/build/bin/mlir-translate",
        mlirOpt: "/tc/llvm-project/build/bin/mlir-opt",
      });

      const args = await argv(dir);
      expect(args).toContain("--mlir-translate /tc/llvm-project/build/bin/mlir-translate");
      expect(args).toContain("--mlir-opt /tc/llvm-project/build/bin/mlir-opt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records the asked timeout in the invocation", async () => {
    const { dir, path } = stub(F);
    try {
      const result = await new Llrwt(path).apply(F, ["add_zero"], { timeoutMs: 1234 });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(result.invocation.timeoutMs).toBe(1234);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("translator complaints are bridge errors", async () => {
    const { dir, path } = stub("", 1, "mlir-translate: input.ll:1:1: expected operation");
    try {
      const result = await new Llrwt(path).apply(F, ["add_zero"]);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.code).toBe("bridge_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rewrite it cannot verify is a verify error", async () => {
    const { dir, path } = stub("", 1, "Error verifying rewritten program: out of bounds");
    try {
      const result = await new Llrwt(path).apply(F, ["add_zero"]);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.code).toBe("verify_error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("anything else on exit 1 is a parse error", async () => {
    const { dir, path } = stub("", 1, "expected operation name");
    try {
      const result = await new Llrwt(path).apply(F, ["add_zero"]);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.code).toBe("parse_error");
      expect(result.message).toContain("expected operation name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("any other exit 2 is our bug, not a refusal", async () => {
    const { dir, path } = stub("", 2, "Unrecognized flag '--frobnicate'.");
    try {
      await expect(new Llrwt(path).apply(F, ["add_zero"])).rejects.toBeInstanceOf(LlrwtCrash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a run we killed is a timeout, not a broken installation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alive-next-llrwt-stub-"));
    const path = join(dir, "llrwt");
    // `exec` so the process we kill is the one holding the pipes, which is
    // what llrwt is when it is not a stub.
    writeFileSync(path, `#!/usr/bin/env bash\nexec sleep 30\n`);
    chmodSync(path, 0o755);
    try {
      const result = await new Llrwt(path).apply(F, ["add_zero"], { timeoutMs: 200 });
      if (result.ok) throw new Error("expected a refusal");
      expect(result.code).toBe("timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a binary that will not run is a broken installation", async () => {
    await expect(
      new Llrwt(join(tmpdir(), "alive-next-no-such-llrwt")).apply(F, ["add_zero"]),
    ).rejects.toBeInstanceOf(LlrwtCrash);
  });
});

// The toolchain build, which is what pins the llrwt side of the contract:
// the translators are named explicitly, since a system mlir-translate prints
// a generic form llrwt does not parse.
const translators = {
  mlirTranslate: toolchain.mlir("mlir-translate"),
  mlirOpt: toolchain.mlir("mlir-opt"),
};
const real = new Llrwt(toolchain.path("llrwt"), 60_000, translators);
const installed =
  existsSync(translators.mlirTranslate) &&
  existsSync(translators.mlirOpt) &&
  (await real
    .version()
    .then((line) => line.startsWith("llrwt "))
    .catch(() => false));

describe.skipIf(!installed)("llrwt against the toolchain build", () => {
  test("folds with a named rule", async () => {
    const result = await real.apply(F, ["addi-zero-to-x"]);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expect(result.changed).toBe(true);
    expect(result.module).not.toContain("add i32");
    expect(result.module).toContain("ret i32");
  });

  test("leaves what no rule matches, printed afresh rather than echoed", async () => {
    const result = await real.apply(F, ["subi-self-to-zero"]);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    // The add survives, under the roundtrip's own value names.
    expect(result.module).toMatch(/add i32 %\d+, 0/);
    expect(result.module).not.toBe(F);
  });

  test("an unknown rule is a refusal on exit 2", async () => {
    const result = await real.apply(F, ["frobnicate"]);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("unknown_rule");
    expect(result.message).toContain("frobnicate");
  });

  test("lists the rule table the driver offers", async () => {
    expect(await real.listRules()).toContain("addi-zero-to-x");
  });

  test("garbage in is a bridge error on exit 1", async () => {
    const result = await real.apply("this is not valid LLVM IR\n", ["addi-zero-to-x"]);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("bridge_error");
    expect(result.message).toMatch(/mlir-translate/i);
  });

  test("several rules run to fixpoint", async () => {
    const chained = `define i32 @f(i32 %x) {
entry:
  %a = add i32 %x, 0
  %m = mul i32 %a, 2
  ret i32 %m
}
`;
    const result = await real.apply(chained, ["addi-zero-to-x", "muli-pow2-to-shl"]);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    expect(result.module).not.toContain("add i32");
    expect(result.module).toMatch(/shl i32 %\d+, 1/);
  });
});
