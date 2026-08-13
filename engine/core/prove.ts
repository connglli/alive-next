// Proving a scenario: the interactive framework's one-call API.
//
// A scenario is a pair and the moves that prove it. This is the function that
// turns that script into a session directory with a verdict, which is what
// makes it more than a test: the trajectory, the store and the certificate
// are left on disk for the visualizer and the checker to read.
//
// The toolchain is resolved from the configuration, and a toolchain that
// disagrees with itself produces failures that read as bad proofs, so it stops
// the run rather than a goal.
import { join } from "node:path";
import { certify } from "../cert/main.ts";
import { loadConfig, repoRoot } from "./config.ts";
import { AliveTv } from "./drivers/alive2.ts";
import { Llops } from "./drivers/llops.ts";
import { Llubi } from "./drivers/llubi.ts";
import type { Scenario } from "./scenario.ts";
import { Session } from "./session.ts";
import { type Timeouts, timeoutsFrom } from "./state/steps.ts";
import { Toolchain } from "./toolchain.ts";

/** Where the run lands; defaults to `sessions/<name>-<stamp>`. */
export interface ProveOptions {
  dir?: string;
  timeouts?: Timeouts;
}

/** Run one scenario to a verdict. Answers whether it reached the one it claims. */
export async function prove(one: Scenario, options: ProveOptions = {}): Promise<boolean> {
  const config = loadConfig();
  const timeouts = options.timeouts ?? timeoutsFrom(config.timeouts);
  const toolchain = new Toolchain(config.toolchain);
  const built = await toolchain.insist();
  const llops = new Llops(toolchain.path("llops"));
  const checker = new AliveTv(toolchain.path("alive-tv"), timeouts.alive2Ms);
  const interp = new Llubi(toolchain.path("llubi"), config.timeouts.llubiMs);

  const dir = options.dir ?? join(repoRoot(), "sessions", `${one.name}-${stamp()}`);
  console.log(`\n${one.name}: ${one.about}\n  ${dir}`);
  const session = await Session.start({
    dir,
    src: one.src,
    tgt: one.tgt,
    llops,
    checker,
    interp,
    timeouts,
    config,
    toolchain: built,
  });

  const started = Date.now();
  try {
    await one.prove(session);
  } catch (error) {
    console.log(`  stopped: ${(error as Error).message}`);
  }
  const outcome = session.finish();
  const goals = [...session.tree.goals.values()]
    .map((goal) => `${goal.id} ${goal.status}`)
    .join(", ");
  console.log(`  ${outcome} in ${Date.now() - started}ms: ${goals}`);
  // Both verdicts are delivered as a package, so a run that earns one writes
  // it; only "unknown" has nothing to hand over.
  if (outcome !== "unknown") console.log(`  ${certify(dir, join(dir, "certificate"))}`);
  return outcome === (one.verdict ?? "verified");
}

/** A directory name that sorts by when it was made. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}
