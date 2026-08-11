// The sandbox: the seven tools a model touches the machine through (read,
// write, edit, grep, ls, find, bash), each a Pi implementation confined to
// the run's workdir directory, the shell by bubblewrap, the file tools
// through their operation hooks, both keeping everything else out: the run's
// record, Pi's credentials, the repository, the network.
//
// The bare names replace Pi's built-ins on purpose, which is Pi's own
// tool-override pattern, and what a replacement keeps is the built-in
// rendering, since the TUI looks a renderer up by name.
import { spawn } from "node:child_process";
import { constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  defineTool,
  type EditOperations,
  type GrepOperations,
  getAgentDir,
  type LsOperations,
  type ReadOperations,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { repoRoot } from "../../core/config.ts";
import { LAYOUT } from "../../core/toolchain.ts";

/** The names Pi's built-ins had, which the sandbox tools now carry. */
export const SANDBOX_TOOLS = ["read", "write", "edit", "grep", "ls", "find", "bash"] as const;

/** The toolchain's binary directories, joined at the tail of a PATH. */
function toolchainPath(path: string | undefined, toolchain: string): string {
  const bins = Object.entries(LAYOUT).flatMap(([name, { at }]) =>
    name === "llvm-config" ? [] : [join(toolchain, dirname(at))],
  );
  return [...(path ? [path] : []), ...bins].join(":");
}

/** Resolve the target, symlinks included; a not-yet-written file is resolved through its ancestor. */
function realRoot(target: string): string {
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return realpathSync(probe);
}

/** The door every tool shares: refuse anything not the workdir itself or under it. */
function confine(workdir: string, absolute: string): void {
  const root = realRoot(workdir);
  const real = realRoot(absolute);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`outside the workdir directory: ${absolute}`);
  }
}

/** Resolve the way Pi's tools do: absolute, `~`, or relative to the workdir. */
function resolveAgainst(workdir: string, given: string): string {
  const home = homedir();
  const expanded =
    given === "~" ? home : given.startsWith("~/") ? join(home, given.slice(2)) : given;
  return resolve(workdir, expanded);
}

/** The operation hooks, one per file tool, each behind the same door. */
function confinedOps(workdir: string): {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  grep: GrepOperations;
  ls: LsOperations;
} {
  return {
    read: {
      access: (path) => {
        confine(workdir, path);
        return access(path, constants.R_OK);
      },
      readFile: async (path) => {
        confine(workdir, path);
        return readFile(path);
      },
    },
    write: {
      mkdir: async (dir) => {
        confine(workdir, dir);
        await mkdir(dir, { recursive: true });
      },
      writeFile: async (path, content) => {
        confine(workdir, path);
        await writeFile(path, content, "utf-8");
      },
    },
    edit: {
      access: (path) => {
        confine(workdir, path);
        return access(path, constants.R_OK | constants.W_OK);
      },
      readFile: (path) => {
        confine(workdir, path);
        return readFile(path);
      },
      writeFile: async (path, content) => {
        confine(workdir, path);
        await writeFile(path, content, "utf-8");
      },
    },
    grep: {
      isDirectory: (path) => {
        confine(workdir, path);
        return statSync(path).isDirectory();
      },
      readFile: (path) => {
        confine(workdir, path);
        return readFileSync(path, "utf8");
      },
    },
    ls: {
      exists: (path) => {
        confine(workdir, path);
        return existsSync(path);
      },
      stat: (path) => {
        confine(workdir, path);
        return statSync(path);
      },
      readdir: (path) => {
        confine(workdir, path);
        return readdirSync(path);
      },
    },
  };
}

/**
 * The shell's operations: bubblewrap, ro root, writable workdir and /tmp,
 * record and credentials unmounted, network closed, env the host's own. The
 * sandbox runtime is Pi's own; the first command of a run pays the error
 * when its dependencies (bubblewrap, socat, ripgrep on Linux) are missing.
 */
function sandboxedShell(workdir: string, toolchain: string): BashOperations {
  const env = {
    ...process.env,
    PATH: toolchainPath(process.env.PATH, toolchain),
  };
  // The run's record, by exact paths rather than by its directory: blocking
  // the directory would shadow the workdir directory it contains.
  const record = [
    join(dirname(workdir), "trajectory.jsonl"),
    join(dirname(workdir), "store"),
    join(dirname(workdir), "certificate"),
  ];
  let ready: Promise<void> | undefined;
  return {
    async exec(command, cwd, { onData, signal, timeout }) {
      ready ??= SandboxManager.initialize({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
          denyRead: [...record, getAgentDir()],
          allowWrite: [workdir, "/tmp"],
          denyWrite: [],
        },
      });
      await ready;
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      const child = spawn("bash", ["-c", wrapped], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      return new Promise((resolve, reject) => {
        let timedOut = false;
        const kill = (): void => {
          try {
            process.kill(-(child.pid ?? 0), "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        };
        const killTimer =
          timeout === undefined
            ? undefined
            : setTimeout(() => {
                timedOut = true;
                kill();
              }, timeout * 1000);
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", (wrong) => {
          if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener("abort", kill);
          reject(wrong);
        });
        signal?.addEventListener("abort", kill, { once: true });
        child.on("close", (code) => {
          if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener("abort", kill);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}

/**
 * The six sandbox tools. The workdir is where the shell starts and every
 * path resolves from; `toolchain` is where the search's binaries sit, which
 * is what the shell's PATH tail points at.
 */
export function createSandboxTools(workdir: string, toolchain?: string): ToolDefinition[] {
  const ops = confinedOps(workdir);
  const bashOps = sandboxedShell(workdir, toolchain ?? join(repoRoot(), "deps"));

  const read = createReadTool(workdir, { operations: ops.read });
  const write = createWriteTool(workdir, { operations: ops.write });
  const edit = createEditTool(workdir, { operations: ops.edit });
  const grep = createGrepTool(workdir, { operations: ops.grep });
  const ls = createLsTool(workdir, { operations: ops.ls });
  const find = createFindTool(workdir);
  const bash = createBashTool(workdir, { operations: bashOps });

  return [
    defineTool({
      name: read.name,
      label: read.label,
      description:
        "Read a text file, which must be inside the workdir directory. Relative paths are relative to it, and a path that resolves anywhere else is refused. Long files are truncated and say how to continue.",
      parameters: read.parameters,
      execute: (id, params, signal, onUpdate) => read.execute(id, params, signal, onUpdate),
    }),
    defineTool({
      name: write.name,
      label: write.label,
      description:
        "Write a file, creating parent directories, inside the workdir directory. Relative paths are relative to it, and a path that resolves anywhere else is refused.",
      parameters: write.parameters,
      execute: (id, params, signal, onUpdate) => write.execute(id, params, signal, onUpdate),
    }),
    defineTool({
      name: edit.name,
      label: edit.label,
      description:
        "Edit a text file by exact text replacement, inside the workdir directory. Every oldText must match a unique block of the file, and each edit matches against the file as it was, so edits in one call must not overlap. Relative paths are relative to it, and a path that resolves anywhere else is refused.",
      parameters: edit.parameters,
      execute: (id, params, signal, onUpdate) => edit.execute(id, params, signal, onUpdate),
    }),
    defineTool({
      name: grep.name,
      label: grep.label,
      description:
        "Search file contents with ripgrep, inside the workdir directory. A `path` that resolves anywhere else is refused. Respects .gitignore rules it finds.",
      parameters: grep.parameters,
      execute: async (id, params, signal, onUpdate) => {
        // Refuse the search root here, where the message can say why: Pi
        // answers a refused operation with "Path not found".
        if (params.path !== undefined) confine(workdir, resolveAgainst(workdir, params.path));
        return grep.execute(id, params, signal, onUpdate);
      },
    }),
    defineTool({
      name: ls.name,
      label: ls.label,
      description:
        "List a directory, which must be inside the workdir directory. Relative paths are relative to it, and a path that resolves anywhere else is refused.",
      parameters: ls.parameters,
      execute: (id, params, signal, onUpdate) => ls.execute(id, params, signal, onUpdate),
    }),
    defineTool({
      name: find.name,
      label: find.label,
      description:
        "Find files by glob pattern, inside the workdir directory. A `path` that resolves anywhere else is refused. Respects .gitignore rules it finds.",
      parameters: find.parameters,
      execute: async (id, params, signal, onUpdate) => {
        // Same door as grep, and the only one find has: it never asks its
        // operations for a search root.
        if (params.path !== undefined) confine(workdir, resolveAgainst(workdir, params.path));
        return find.execute(id, params, signal, onUpdate);
      },
    }),
    defineTool({
      name: bash.name,
      label: bash.label,
      description:
        "Run one shell command where the agent is allowed to work. Commands start in the workdir directory and the machine is sandboxed: the whole filesystem is read-only except the workdir directory and the system's /tmp, the network is closed, and the environment is the host's own, with the toolchain's binaries at the tail of PATH. Output streams, the exit status ends the answer, and a command that hangs is killed when its timeout runs out.",
      parameters: bash.parameters,
      execute: (id, params, signal, onUpdate) => bash.execute(id, params, signal, onUpdate),
    }),
  ];
}
