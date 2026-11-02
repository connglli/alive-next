import type { Execution, ProcessResult, Standing, Verdict } from "./protocol.ts";

/** A completed check attempt, including an inconclusive or refused answer. */
export interface Check extends ProcessResult {
  checker: "alive2" | "llops respected" | "llops reshaped";
}

// One lifecycle variant is active at a time; history is retained independently.
export type RunStatus =
  | { kind: "ready" }
  | { kind: "running"; loading?: string; activity?: string }
  | { kind: "finished"; verdict: Verdict }
  | { kind: "stopped"; reason: "user" | "timeout" }
  | { kind: "error"; message: string };

export interface SessionState {
  status: RunStatus;
  standing: Standing;
  checks: readonly Check[];
  elapsedMs: number;
  /** Quick inspection requires the search worker's in-memory program store. */
  inspectable: boolean;
  /** Recorded history can still be viewed or saved after that worker stops. */
  hasReport: boolean;
}

export function emptySession(): SessionState {
  return {
    status: { kind: "ready" },
    standing: { goals: [] },
    checks: [],
    elapsedMs: 0,
    inspectable: false,
    hasReport: false,
  };
}

export function checkOf(request: Execution, result: ProcessResult): Check | undefined {
  // Parsing, editing and analysis are toolbox calls, but do not certify refinement.
  const command = request.args[0];
  const checker =
    request.tool === "alive-tv"
      ? "alive2"
      : command === "respected" || command === "reshaped"
        ? (`llops ${command}` as const)
        : undefined;
  return checker ? { ...result, checker } : undefined;
}

export function evidence(checks: readonly Check[], verdict: Verdict) {
  // A structural mismatch is inconclusive; refutation evidence must come from alive2.
  return verdict === "counterexample"
    ? checks.findLast(
        (check) =>
          check.checker === "alive2" &&
          /^\s*[1-9]\d* incorrect transformations$/m.test(check.stdout),
      )
    : checks.at(-1);
}
