// The toolchain: the directory holding the binaries that have to agree.
//
// llops, alive-tv and llubi mean the same thing by a module only when they
// were built against the same LLVM, so a run takes one directory rather than
// three paths: the one scripts/depman.sh builds into, from pinned revisions
// against one LLVM. llrwt joins them there as the verified rewriter: a Lean
// binary with no LLVM banner, so a run asks it for a version, not a release.
// The layout below is the contract between the two, and
// docs/implementation.md states it for people.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where each binary sits, and how it is asked which LLVM it carries. */
export const LAYOUT = {
  llops: { at: "llops/build/llops", version: ["version"] },
  "alive-tv": { at: "alive2/build/alive-tv", version: ["--version"] },
  llubi: { at: "llubi-legacy/build/llubi", version: ["--version"] },
  llrwt: { at: "veir/.lake/build/bin/llrwt", version: ["--version"] },
  "llvm-config": { at: "llvm-project/build/bin/llvm-config", version: ["--version"] },
} as const;

export type ToolName = keyof typeof LAYOUT;

/** The three a run spawns; llvm-config is for the build, not for us. */
const CHECKED: ToolName[] = ["llops", "alive-tv", "llubi"];

/** What one binary answered when asked which LLVM it was built against. */
export interface ToolReport {
  path: string;
  /** The LLVM release it reports, absent when it could not be asked. */
  llvm?: string;
  /** The version line it prints, kept for binaries like llrwt that carry no LLVM banner. */
  version?: string;
  /** Why it could not be asked: missing, or it would not run. */
  error?: string;
}

export interface ToolchainReport {
  dir: string;
  tools: Record<string, ToolReport>;
  /** toolchain.json as depman.sh wrote it, when the directory has one. */
  stamp?: unknown;
}

/** Thrown when the toolchain cannot be the one thing it has to be. */
export class ToolchainError extends Error {
  constructor(message: string) {
    super(`toolchain: ${message}`);
    this.name = "ToolchainError";
  }
}

export class Toolchain {
  constructor(readonly dir: string) {}

  path(name: ToolName): string {
    return join(this.dir, LAYOUT[name].at);
  }

  /**
   * One of the MLIR translators llrwt runs under, built with the
   * toolchain's LLVM rather than beside the other binaries.
   */
  mlir(name: "mlir-translate" | "mlir-opt"): string {
    return join(this.dir, "llvm-project/build/bin", name);
  }

  has(name: ToolName): boolean {
    return existsSync(this.path(name));
  }

  /**
   * What was built and from which revisions, as depman.sh recorded it. A run
   * snapshots this, so a trajectory says which toolchain produced it; a
   * directory built by hand has none, which is not an error, only less to say.
   */
  stamp(): unknown | undefined {
    const path = join(this.dir, "toolchain.json");
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  /** Ask each binary which LLVM it carries, which is how they are compared. */
  async report(): Promise<ToolchainReport> {
    const tools: Record<string, ToolReport> = {};
    for (const name of CHECKED) {
      tools[name] = await ask(this.path(name), LAYOUT[name].version);
    }
    tools.llrwt = await askVersion(this.path("llrwt"), LAYOUT.llrwt.version);
    return { dir: this.dir, tools, stamp: this.stamp() };
  }

  /**
   * The report, or a throw naming what is wrong. A run calls this before it
   * starts, because every failure it prevents is one that would otherwise be
   * read as a bad proof rather than a bad install.
   */
  async insist(): Promise<ToolchainReport> {
    const report = await this.report();
    const broken = Object.entries(report.tools).filter(([, tool]) => tool.error);
    if (broken.length > 0) {
      throw new ToolchainError(
        `${this.dir} is not built.\n${broken
          .map(([name, tool]) => `  ${name}: ${tool.error}`)
          .join("\n")}\nRun 'make install-deps' with TOOLCHAIN=${this.dir}.`,
      );
    }
    const versions = new Set(CHECKED.map((name) => report.tools[name]?.llvm));
    if (versions.size > 1) {
      throw new ToolchainError(
        `${this.dir} mixes LLVM versions, so its tools do not agree on what a module means.\n${CHECKED.map(
          (name) => `  ${name}: LLVM ${report.tools[name]?.llvm}`,
        ).join("\n")}\nRebuild it with 'make install-deps FORCE=1 TOOLCHAIN=${this.dir}'.`,
      );
    }
    return report;
  }
}

/** The LLVM release a binary prints, however it words its version banner. */
export function llvmVersion(text: string): string | undefined {
  return text.match(/LLVM (?:version )?(\d+(?:\.\d+)+)/)?.[1];
}

async function ask(path: string, version: readonly string[]): Promise<ToolReport> {
  if (!existsSync(path)) return { path, error: `no binary at ${path}` };
  try {
    const child = Bun.spawn([path, ...version], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const llvm = llvmVersion(out) ?? llvmVersion(err);
    return llvm ? { path, llvm } : { path, error: "it does not say which LLVM it carries" };
  } catch (error) {
    return { path, error: (error as Error).message };
  }
}

/**
 * Ask the rewriter for its version line. It carries no LLVM banner, so a
 * version line is what counts as built.
 */
async function askVersion(path: string, version: readonly string[]): Promise<ToolReport> {
  if (!existsSync(path)) return { path, error: `no binary at ${path}` };
  try {
    const child = Bun.spawn([path, ...version], { stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const line = out.trim();
    if (child.exitCode !== 0 || line === "") return { path, error: "it does not print a version" };
    return { path, version: line };
  } catch (error) {
    return { path, error: (error as Error).message };
  }
}
