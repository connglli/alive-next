// What an end-to-end scenario is: a pair, and the moves that prove it.
//
// A scenario is a script rather than a search. It makes the moves an agent
// would make, in one fixed order, and every move has to succeed, so a scenario
// that stops saying "verified" says which move stopped working and why. That
// is the point of them: the framework is exercised through the same door the
// agent uses, with nothing in front of it that has to be prompted, paid for,
// or believed.
import type { Session } from "./session.ts";

export interface Scenario {
  /** Also the session directory the runner writes it to. */
  name: string;
  /** What it demonstrates, in one line. */
  about: string;
  /** The verdict the script claims to reach, "verified" unless it says so. */
  verdict?: "verified" | "counterexample";
  src: string;
  tgt: string;
  /** The moves, in order. Throws with the reason when one is refused. */
  prove(session: Session): Promise<void>;
}

/** A refusal in a script is a broken script, so it stops with what it said. */
export function expect(what: string, ok: boolean, result: unknown): void {
  if (!ok) throw new Error(`${what}: ${why(result)}`);
}

/** Whatever a refusal said, wherever the result in hand keeps it. */
export function why(result: unknown): string {
  const refusal = result as {
    message?: string;
    reason?: string;
    detail?: string;
    check?: { detail?: string; outcome?: string };
  };
  return (
    refusal.message ??
    refusal.reason ??
    refusal.detail ??
    refusal.check?.detail ??
    refusal.check?.outcome ??
    "refused"
  );
}
