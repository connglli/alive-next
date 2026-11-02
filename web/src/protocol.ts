export type Tool = "llops" | "alive-tv";

export interface Execution {
  tool: Tool;
  args: string[];
  stdin: string;
  files: Record<string, string>;
}

export interface ProcessResult {
  exit: number;
  stdout: string;
  stderr: string;
  ms: number;
}

// Progress messages carry goal metadata; inspection requests fetch the full IR.
export interface GoalView {
  id: string;
  parent?: string;
  role?: string;
  status: string;
}

export interface Standing {
  goals: GoalView[];
}

export type Verdict = "verified" | "counterexample" | "unknown";

export interface ReportSource {
  trajectory: string[];
  programs: Record<string, string>;
}

export type WorkerMessage =
  | { type: "trajectory"; line: string }
  | { type: "program"; hash: string; text: string }
  | { type: "exec"; id: number; request: Execution }
  | { type: "kill"; id: number }
  | { type: "progress"; state: Standing; activity: string }
  | { type: "result"; verdict: Verdict; state: Standing }
  | { type: "error"; message: string }
  | { type: "inspection"; gid: string; src: string; tgt: string };
