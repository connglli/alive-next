// trajectory.jsonl: what happened, in order, as the only source of truth.
//
// One JSON object per line, appended synchronously so a crash leaves an honest
// prefix rather than a truncated last line. Each line carries the hash of the
// line before it, which makes the file a chain: altering a line breaks every
// line after it, and the break says where.
//
// The goal tree is not stored anywhere. It is derived by replaying this file,
// so there is one thing to keep right instead of two things to keep in step.
//
// What the chain is for: an edit to any line but the last one is caught, and
// caught at the line after the edit. It is evidence against accident and
// casual editing, not against someone who recomputes the chain, which is why
// a verdict rests on replaying the certificate rather than on this file.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "./hash.ts";

/** Programs are named by their store hash wherever an event mentions one. */
export type Hash = string;

export interface RunStart {
  kind: "run_start";
  src: Hash;
  tgt: Hash;
  /** The fully resolved configuration, so a run says what produced it. */
  config: unknown;
  /**
   * The toolchain this run spawned: where it is, which LLVM each binary
   * carries, and the revisions it was built from. A verdict is only as
   * reproducible as the binaries that produced it.
   */
  toolchain?: unknown;
  /** Version lines for everything else, the model above all. */
  versions: Record<string, string>;
}

/** An agent turn, verbatim, in whatever shape the harness produced it. */
export interface MessageEvent {
  kind: "message";
  message: unknown;
}

/**
 * What an event did to the goal tree.
 *
 * The tree is derived by replaying these, so this is the alphabet of every
 * state change there is. It lives with the log rather than with the deriver
 * because it is part of what the log records: a tool result carries the
 * effect it had, and the text the model reads is rendered from the same
 * result, so there is one record of what happened rather than two.
 */
export type Effect =
  /** A side advanced to a new program, by a rule or by a checked step. */
  | { effect: "step"; gid: string; side: "src" | "tgt"; to: Hash; how: "rule" | "checked" }
  /** A goal was cut in two; the children arrive with their initial pairs. */
  | {
      effect: "split";
      gid: string;
      /** The outlined function, named here so no reader has to guess it. */
      name: string;
      outer: { gid: string; src: Hash; tgt: Hash };
      callee: { gid: string; src: Hash; tgt: Hash };
    }
  /**
   * Both sides of a callee goal gained an attribute on the outlined
   * function's parameter. This is not a step: adding an attribute to a
   * definition introduces UB where the old program was defined, so neither
   * direction of a refinement check would certify it. What makes it sound is
   * the assume at the call site, and `by` names the step that put it there.
   */
  | { effect: "strengthen"; gid: string; src: Hash; tgt: Hash; by: { gid: string; hash: Hash } }
  /** A split was undone, discarding both children and their subtrees. */
  | { effect: "unsplit"; gid: string }
  /** A side went back to an earlier program of its own history. */
  | { effect: "revert"; gid: string; side: "src" | "tgt"; to: Hash }
  | { effect: "proved"; gid: string }
  | { effect: "refuted"; gid: string };

export interface ToolCall {
  kind: "tool_call";
  id: string;
  tool: string;
  args: unknown;
}

export interface ToolResult {
  kind: "tool_result";
  id: string;
  tool: string;
  /**
   * What it did to the tree, in order, and empty for a tool that only reads.
   * A list rather than one effect because a tool is one move the agent made:
   * strengthen lands four records and may discharge two goals, and splitting
   * that across four lines would lose which move they came from.
   */
  effects?: Effect[];
  result: unknown;
  /** Milliseconds the tool took, which is where a slow run shows itself. */
  ms: number;
}

/** Something the framework did on its own: an eager check, a root replay. */
export interface AutoEvent {
  kind: "auto";
  action: string;
  /** An eager check that discharges a goal changes the tree like a tool does. */
  effects?: Effect[];
  outcome: unknown;
}

export interface Verdict {
  kind: "verdict";
  outcome: "verified" | "counterexample" | "unknown";
  certificate?: string;
}

export type Event = RunStart | MessageEvent | ToolCall | ToolResult | AutoEvent | Verdict;

/** An event as it sits in the file: what happened, when, and what preceded it. */
export type Entry = Event & { time: number; prev: Hash };

/** Thrown when the chain does not hold, naming the line that broke it. */
export class TrajectoryBroken extends Error {
  constructor(
    readonly line: number,
    detail: string,
  ) {
    super(`trajectory line ${line}: ${detail}`);
    this.name = "TrajectoryBroken";
  }
}

/** The hash an empty trajectory continues from. */
const GENESIS = "";

export class Trajectory {
  private last: Hash;

  constructor(private readonly path: string) {
    mkdirSync(dirname(this.path), { recursive: true });
    // Appending to a file that already has lines has to continue its chain,
    // which is what makes a resumed run indistinguishable from an unbroken one.
    this.last = existsSync(this.path) ? lastHashOf(readFileSync(this.path, "utf8")) : GENESIS;
  }

  /**
   * Append one event. The write is synchronous and unbuffered: the framework
   * holds the pen, and a tool that runs after this returns is a tool the file
   * already knows about.
   */
  append(event: Event, now: number = Date.now()): Entry {
    const entry: Entry = { ...event, time: now, prev: this.last };
    const line = JSON.stringify(entry);
    appendFileSync(this.path, `${line}\n`, "utf8");
    this.last = sha256(line);
    return entry;
  }

  /** Every event in order, with the chain checked as it goes. */
  read(): Entry[] {
    if (!existsSync(this.path)) return [];
    return parse(readFileSync(this.path, "utf8"));
  }
}

/** Parse and verify a trajectory's text, so a reader needs no session on disk. */
export function parse(text: string): Entry[] {
  const entries: Entry[] = [];
  let expected = GENESIS;
  let number = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    number += 1;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch (error) {
      throw new TrajectoryBroken(number, `not JSON, ${(error as Error).message}`);
    }
    if (entry.prev !== expected) {
      throw new TrajectoryBroken(number, `follows ${entry.prev || "nothing"}, not ${expected}`);
    }
    entries.push(entry);
    expected = sha256(line);
  }
  return entries;
}

function lastHashOf(text: string): Hash {
  const lines = text.split("\n").filter((line) => line !== "");
  const last = lines[lines.length - 1];
  return last === undefined ? GENESIS : sha256(last);
}
