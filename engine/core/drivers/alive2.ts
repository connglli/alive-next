// Driving alive-tv, the checker a verdict rests on.
//
// Two files, and alive-tv asks whether the functions in the second refine
// those in the first, which is exactly the claim a goal makes. The framework
// decides which program plays which part; this driver runs what it is told and
// reports what came back.
//
// The exit code is not the answer. alive-tv exits non-zero only for its own
// errors, so an incorrect transformation exits 0, and the summary block it
// prints is what says how the check went. `--quiet` is deliberately not passed:
// the counterexample is the point.
//
// No flag here weakens what alive2 is asked, `--disable-undef-input` least of
// all: for a callee goal it assumes what the cut has to prove. Definedness is
// stated in the IR instead, as docs/implementation.md sets out.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CheckOutcome =
  /** tgt refines src. */
  | "correct"
  /** It does not, and the detail holds the counterexample alive2 printed. */
  | "incorrect"
  /** Neither shown: a timeout, or an approximation alive2 would not commit to. */
  | "unknown"
  /** alive2 could not run the check at all, which is a tooling problem. */
  | "error";

/** Exactly what ran, so a certificate can be replayed with the same options. */
export interface Invocation {
  binary: string;
  /** Options only; the two file paths belong to the run that made them. */
  flags: string[];
  timeoutMs: number;
}

export interface CheckResult {
  outcome: CheckOutcome;
  /** The counterexample, or the reason, as alive-tv put it. */
  detail: string;
  invocation: Invocation;
  /** The four counts alive-tv summarises with, absent if it printed none. */
  summary?: { correct: number; incorrect: number; failed: number; errors: number };
  stdout: string;
  ms: number;
}

export interface CheckOptions {
  /** SMT query timeout in milliseconds, alive-tv's own `--smt-to`. */
  timeoutMs?: number;
  /** Extra options, for the search knobs a caller may want. */
  flags?: string[];
}

/** How long the process may outlive its SMT budget before it is killed. */
const GRACE_MS = 30_000;

/**
 * Thrown when alive-tv cannot be run at all. That is a broken installation
 * rather than a search outcome, and turning it into one would let a run report
 * "unknown" when the truth is that nothing was ever checked.
 */
export class AliveTvCrash extends Error {
  constructor(binary: string, detail: string) {
    super(`alive-tv: cannot run ${binary}: ${detail}`);
    this.name = "AliveTvCrash";
  }
}

export class AliveTv {
  constructor(
    private readonly path: string = "alive-tv",
    private readonly defaultTimeoutMs: number = 120_000,
  ) {}

  async version(): Promise<string> {
    const child = Bun.spawn([this.path, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    // alive-tv opens with LLVM's banner, whose first line is a URL. The line
    // that names a version is the one a manifest wants to record.
    const lines = out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    return lines.find((line) => /version/i.test(line)) ?? lines[0] ?? "";
  }

  /** Ask whether `tgt` refines `src`. */
  async check(src: string, tgt: string, options: CheckOptions = {}): Promise<CheckResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const flags = [`--smt-to=${timeoutMs}`, ...(options.flags ?? [])];
    const invocation: Invocation = { binary: this.path, flags, timeoutMs };

    const dir = mkdtempSync(join(tmpdir(), "alive-next-tv-"));
    const srcPath = join(dir, "src.ll");
    const tgtPath = join(dir, "tgt.ll");
    writeFileSync(srcPath, src, "utf8");
    writeFileSync(tgtPath, tgt, "utf8");

    const started = Date.now();
    try {
      const spawn = () =>
        Bun.spawn([this.path, srcPath, tgtPath, ...flags], { stdout: "pipe", stderr: "pipe" });
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn();
      } catch (error) {
        throw new AliveTvCrash(this.path, (error as Error).message);
      }
      // The SMT timeout bounds a query, not the process, so a solver that
      // wedges needs a wall clock of its own.
      const killer = setTimeout(() => child.kill(), timeoutMs + GRACE_MS);
      const [out, err] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      clearTimeout(killer);
      const ms = Date.now() - started;
      return { ...read(out, err), invocation, stdout: out, ms };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Read the outcome out of what alive-tv printed. */
export function read(
  stdout: string,
  stderr = "",
): Pick<CheckResult, "outcome" | "detail" | "summary"> {
  const count = (what: string): number | undefined => {
    const found = stdout.match(new RegExp(`^\\s*(\\d+) ${what}$`, "m"));
    return found ? Number(found[1]) : undefined;
  };
  const correct = count("correct transformations");
  const incorrect = count("incorrect transformations");
  const failed = count("failed-to-prove transformations");
  const errors = count("Alive2 errors");

  if (
    correct === undefined ||
    incorrect === undefined ||
    failed === undefined ||
    errors === undefined
  ) {
    // No summary means it never got as far as comparing, so whatever it said
    // is the whole story: an unreadable file, mismatched triples, a crash.
    const detail = (stdout.trim() || stderr.trim() || "alive-tv said nothing").trim();
    return { outcome: "error", detail };
  }

  const summary = { correct, incorrect, failed, errors };
  if (incorrect > 0) return { outcome: "incorrect", detail: report(stdout), summary };
  if (errors > 0) return { outcome: "error", detail: report(stdout), summary };
  if (failed > 0) return { outcome: "unknown", detail: report(stdout), summary };
  if (correct > 0) return { outcome: "correct", detail: "", summary };
  // Nothing was compared, which means the two files had no function in common.
  return { outcome: "error", detail: "alive-tv compared no functions", summary };
}

/**
 * What alive-tv found, which is what it printed before its summary, minus the
 * two functions it opens by echoing. Those are the pair it was handed, so a
 * reader of the result already has them, and a counterexample is worth more
 * per line than a copy of the question. `stdout` keeps everything.
 */
function report(stdout: string): string {
  const summary = stdout.indexOf("Summary:");
  const said = (summary < 0 ? stdout : stdout.slice(0, summary)).trim();
  const found = said.indexOf("ERROR:");
  return found < 0 ? said : said.slice(found).trim();
}
