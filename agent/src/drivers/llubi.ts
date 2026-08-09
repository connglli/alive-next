// Driving llubi, the UB-aware interpreter a counterexample is certified by.
//
// llubi runs `@main` and reports on stderr: the verbose trace, any UB, and any
// complaint about the module. Nothing comes back on stdout, and the exit code
// carries the returned value truncated to eight bits, so stderr is what this
// reads.
//
// What a run is judged on comes from the trace, which prints each instruction
// with its result. `llops harness` gives those instructions names beginning
// `obs.`, so an observation is one line of the shape
// `%obs.something = load ... -> value`, and the value is kept as the text llubi
// printed: comparing two runs is comparing those strings.
export type RunOutcome =
  /** main returned; the observations say what happened on the way. */
  | "returned"
  /** Immediate UB, which stops execution wherever it happened. */
  | "ub"
  /** llubi would not run the module, or ran out of the budget it was given. */
  | "error";

export interface RunResult {
  outcome: RunOutcome;
  /** Observation name to the value llubi printed, `%obs.result` to `i32 42`. */
  observations: Record<string, string>;
  /** Why, for UB and for an error; empty when the run returned. */
  reason: string;
  /** The instruction UB happened at, when llubi named one. */
  at?: string;
  /** Everything llubi said, kept for the trajectory. */
  trace: string;
  ms: number;
}

export interface RunOptions {
  /** Instructions to allow before giving up; a guard, not a semantic knob. */
  maxSteps?: number;
  /** Extra options, replacing none of the defaults. */
  flags?: string[];
}

/** Thrown when llubi cannot be run at all, which is a broken installation. */
export class LlubiCrash extends Error {
  constructor(binary: string, detail: string) {
    super(`llubi: cannot run ${binary}: ${detail}`);
    this.name = "LlubiCrash";
  }
}

/** How long a run may take before the process is killed. */
const TIMEOUT_MS = 60_000;

export class Llubi {
  constructor(private readonly path: string = "llubi_legacy") {}

  async version(): Promise<string> {
    const child = Bun.spawn([this.path, "--version"], { stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return out.trim().split("\n").slice(0, 2).join(" ").trim();
  }

  /** Run a module, which has to be one `llops harness` produced. */
  async run(module: string, options: RunOptions = {}): Promise<RunResult> {
    const flags = [
      // The trace is the only channel wide enough to carry a return value.
      "--verbose",
      // Counterexamples come from alive2, so llubi is asked to treat
      // uninitialised memory the way alive2 does.
      "--fill-uninitialized-mem-with-poison",
      ...(options.maxSteps ? [`--max-steps=${options.maxSteps}`] : []),
      ...(options.flags ?? []),
    ];

    const started = Date.now();
    const spawn = () =>
      Bun.spawn([this.path, "-", ...flags], {
        stdin: new TextEncoder().encode(module),
        stdout: "pipe",
        stderr: "pipe",
      });
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn();
    } catch (error) {
      throw new LlubiCrash(this.path, (error as Error).message);
    }
    const killer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const [err] = await Promise.all([
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
      child.exited,
    ]);
    clearTimeout(killer);
    return { ...read(err), trace: err, ms: Date.now() - started };
  }
}

/** Read what llubi said into an outcome and the observations it printed. */
export function read(trace: string): Pick<RunResult, "outcome" | "observations" | "reason" | "at"> {
  const observations: Record<string, string> = {};
  for (const line of trace.split("\n")) {
    const named = line.match(/^\s*(%obs\.[\w.]+)\s*=\s*(.*)$/);
    if (!named) continue;
    // The value is what follows the last arrow, since the instruction itself
    // may contain one.
    const at = named[2]?.lastIndexOf(" -> ") ?? -1;
    if (at < 0) continue;
    observations[named[1] as string] = (named[2] as string).slice(at + 4).trim();
  }

  const ub = trace.match(/^UB triggered: (.*)$/m);
  if (ub) {
    const stack = trace.match(/^Stacktrace:\n\s*(.*)$/m);
    return {
      outcome: "ub",
      observations,
      reason: (ub[1] as string).trim(),
      at: stack?.[1]?.trim(),
    };
  }

  if (trace.includes("Exiting function main")) {
    return { outcome: "returned", observations, reason: "" };
  }

  // Anything else is llubi declining. Its complaints are looked for by name
  // because it does not always put them on a line of their own: the step limit
  // is appended to whatever instruction it stopped at.
  const complaint = COMPLAINTS.find((known) => trace.includes(known));
  return {
    outcome: "error",
    observations,
    reason: complaint ?? lastLine(trace) ?? "llubi said nothing",
  };
}

const COMPLAINTS = [
  "Exceed maximum steps",
  "Cannot find entry function",
  "Unsupported main function signature",
];

/** The last thing llubi said, for a complaint that is not one we know. */
function lastLine(trace: string): string | undefined {
  const lines = trace
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines[lines.length - 1];
}
