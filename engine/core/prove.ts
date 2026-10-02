// Proving a scenario: the interactive framework's one-call API.
//
// A scenario is a pair and the moves that prove it. This is the function that
// turns that script into a session directory with a verdict, which is what
// makes it more than a test: the trajectory, the store and the certificate
// are left on disk for the visualizer and the checker to read.
import { join } from "node:path";
import { repoRoot } from "./config.ts";
import { closeRun, stamp, startRun } from "./run.ts";
import type { Scenario } from "./scenario.ts";
import type { Timeouts } from "./state/steps.ts";

/** Where the run lands; defaults to `sessions/<name>-<stamp>`. */
export interface ProveOptions {
  dir?: string;
  timeouts?: Timeouts;
}

/** Run one scenario to a verdict. Answers whether it reached the one it claims. */
export async function prove(one: Scenario, options: ProveOptions = {}): Promise<boolean> {
  const dir = options.dir ?? join(repoRoot(), "sessions", `${one.name}-${stamp()}`);
  console.log(`\n${one.name}: ${one.about}\n  ${dir}`);
  const { session } = await startRun({
    src: one.src,
    tgt: one.tgt,
    dir,
    timeouts: options.timeouts,
  });

  const started = Date.now();
  try {
    await one.prove(session);
  } catch (error) {
    console.log(`  stopped: ${(error as Error).message}`);
  }
  const { outcome, lines } = closeRun(session, started);
  for (const line of lines) console.log(`  ${line}`);
  return outcome === one.verdict;
}
