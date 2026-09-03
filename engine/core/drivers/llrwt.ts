// Driving llrwt, the pre-proved rewrite rule applier.
//
// One process per request: an input file holding LLVM IR, rewritten LLVM IR on
// stdout, exit 0 on success (byte-identical echo when nothing changed), 1 on
// refusal, 2 on misuse. Everything llrwt can refuse is a value here rather
// than an exception, and a refusal is the normal case while an agent searches
// (an unknown rule, input outside the supported subset). Only a broken invocation
// throws, because a binary that will not run is a bug in us, not a move the
// agent made.
//
// The refusal codes below are read off llrwt's stderr while it speaks only
// free text. When llrwt learns stable machine-readable errors the mapping in
// refuse() is what changes; the codes themselves are the contract.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A program, as IR text. */
export type Module = string;

/** Every llrwt answer: the payload, or the code and message it refused with. */
export type LlrwtResult<T> = ({ ok: true } & T) | { ok: false; code: string; message: string };

/** Exactly what ran, so a certificate can be replayed with the same options. */
export interface LlrwtInvocation {
  binary: string;
  rules: string[];
  timeoutMs: number;
}

export interface ApplyResult {
  module: Module;
  /** Byte comparison of stdout against the input, before any canonicalization. */
  changed: boolean;
  invocation: LlrwtInvocation;
}

export interface ApplyOptions {
  /** Wall clock for the whole run, translators included. */
  timeoutMs?: number;
}

/**
 * Thrown when llrwt cannot be run or does not honor its CLI contract. That is
 * a broken installation rather than a search outcome, and turning it into one
 * would let a run report a refusal when the truth is that nothing was ever
 * rewritten.
 */
export class LlrwtCrash extends Error {
  constructor(message: string) {
    super(`llrwt: ${message}`);
    this.name = "LlrwtCrash";
  }
}

/** Grace past the timeout for translator startup and shutdown. */
const GRACE_MS = 10_000;

function wallClock(timeoutMs: number): number {
  return timeoutMs + Math.min(timeoutMs, GRACE_MS);
}

export class Llrwt {
  constructor(
    private readonly path: string = "llrwt",
    private readonly defaultTimeoutMs: number = 30_000,
  ) {}

  /** The version line, which a run records to say what rewrote its programs. */
  async version(): Promise<string> {
    const child = Bun.spawn([this.path, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (child.exitCode !== 0) throw new LlrwtCrash(`--version exited ${child.exitCode}`);
    return out.trim();
  }

  /**
   * Rewrite `module` with the named rules to fixpoint. The input travels on a
   * file because that is the shape llrwt takes; the store never sees the
   * scratch directory, so an agent that can write beside it still cannot reach
   * the programs.
   */
  async apply(
    module: Module,
    rules: string[],
    options: ApplyOptions = {},
  ): Promise<LlrwtResult<ApplyResult>> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const invocation: LlrwtInvocation = { binary: this.path, rules: [...rules], timeoutMs };
    const args = ["--rules", rules.join(","), "--allow-unregistered-dialect"];

    const dir = mkdtempSync(join(tmpdir(), "alive-next-llrwt-"));
    const inPath = join(dir, "in.ll");
    writeFileSync(inPath, module, "utf8");
    try {
      const spawn = () =>
        Bun.spawn([this.path, ...args, inPath], { stdout: "pipe", stderr: "pipe" });
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn();
      } catch (error) {
        throw new LlrwtCrash(`cannot run ${this.path}: ${(error as Error).message}`);
      }
      let killed = false;
      const killer = setTimeout(() => {
        killed = true;
        child.kill();
      }, wallClock(timeoutMs));
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(killer);
      // A process we stopped ourselves said nothing because we stopped it,
      // which is no information rather than a broken installation.
      if (killed) {
        return { ok: false, code: "timeout", message: `killed after ${wallClock(timeoutMs)}ms` };
      }
      if (child.exitCode === 0) {
        return { ok: true, module: out, changed: out !== module, invocation };
      }
      // Exit 2 is a command line llrwt did not understand, which is our bug
      // unless the complaint is about a rule name, which is the agent's: rule
      // names arrive from the tool call, not from us.
      if (child.exitCode === 2 && !isUnknownRule(err)) {
        throw new LlrwtCrash(`exited 2, ${detail(err, out)}`);
      }
      return { ok: false, ...refuse(err, out) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Read a refusal out of what llrwt printed. Exit 1 carries the complaint on stderr. */
function refuse(stderr: string, stdout: string): { code: string; message: string } {
  const message = detail(stderr, stdout);
  if (isUnknownRule(message)) return { code: "unknown_rule", message };
  if (/mlir-translate|mlir-opt/i.test(message)) return { code: "bridge_error", message };
  if (/timed out|timeout/i.test(message)) return { code: "timeout", message };
  return { code: "parse_error", message };
}

/** llrwt reports an unnameable rule as `Unknown rewrite rule: '<name>'`. */
function isUnknownRule(text: string): boolean {
  return /unknown (rewrite )?rule/i.test(text);
}

function detail(stderr: string, stdout: string): string {
  return stderr.trim() || stdout.trim() || "llrwt said nothing";
}
