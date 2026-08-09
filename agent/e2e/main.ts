// Running the scenarios by hand: `bun run e2e [name ...]`, or all of them.
//
// Each one gets its own session directory under `sessions/`, which is what
// makes this more than a test: the trajectory, the store and the verdict are
// left on disk for the visualizer and the certificate checker to read.
import { join } from "node:path";
import { loadConfig, repoRoot } from "../src/config.ts";
import { AliveTv } from "../src/drivers/alive2.ts";
import { Llops } from "../src/drivers/llops.ts";
import { Session } from "../src/session.ts";
import { timeoutsFrom } from "../src/state/steps.ts";
import { Toolchain } from "../src/toolchain.ts";
import type { Scenario } from "./scenario.ts";
import { scenario, scenarios } from "./scenarios.ts";

const config = loadConfig();
const timeouts = timeoutsFrom(config.timeouts);
// Before anything is proved: a toolchain that disagrees with itself produces
// failures that read as bad proofs, so it stops the run rather than a goal.
const toolchain = new Toolchain(config.toolchain);
const built = await toolchain.insist();
const llops = new Llops(toolchain.path("llops"));
const checker = new AliveTv(toolchain.path("alive-tv"), timeouts.alive2Ms);

const asked = process.argv.slice(2);
const chosen = asked.length > 0 ? asked.map(scenario) : scenarios;

let failed = 0;
for (const one of chosen) failed += (await go(one)) ? 0 : 1;
process.exit(failed === 0 ? 0 : 1);

async function go(one: Scenario): Promise<boolean> {
  const dir = join(repoRoot(), "sessions", `${one.name}-${stamp()}`);
  console.log(`\n${one.name}: ${one.about}\n  ${dir}`);
  const session = await Session.start({
    dir,
    src: one.src,
    tgt: one.tgt,
    llops,
    checker,
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
  return outcome === "verified";
}

/** A directory name that sorts by when it was made. */
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}
