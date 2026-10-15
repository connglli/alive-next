// Starting and closing a run: a session on a pair, and its verdict.
//
// Every way of running starts and closes here. A run gets the drivers the
// configuration names, and a toolchain that disagrees with itself stops the
// run rather than a goal, since its failures would read as bad proofs.
import { join } from "node:path";
import { certify } from "../cert/main.ts";
import { loadConfig } from "./config.ts";
import { AliveTv } from "./drivers/alive2.ts";
import { Llops } from "./drivers/llops.ts";
import { Llrwt } from "./drivers/llrwt.ts";
import { Llubi } from "./drivers/llubi.ts";
import { Session } from "./session.ts";
import { type Timeouts, timeoutsFrom } from "./state/steps.ts";
import { Toolchain } from "./toolchain.ts";

export interface RunOptions {
  src: string;
  tgt: string;
  dir: string;
  /** The configuration's timeouts unless given. */
  timeouts?: Timeouts;
  /** Whether the run's first move is an eager check of the root pair. */
  eager?: boolean;
}

/** Start a session on the pair, with the drivers the configuration names. */
export async function startRun(options: RunOptions) {
  const config = loadConfig();
  const timeouts = options.timeouts ?? timeoutsFrom(config.timeouts);
  const toolchain = new Toolchain(config.toolchain);
  const built = await toolchain.insist();
  const llops = new Llops(toolchain.path("llops"), config.timeouts.llopsMs);
  // Checker input files go in the run's directory, which the agent's shell cannot write.
  const tmp = join(options.dir, "tmp");
  const translators = {
    mlirTranslate: toolchain.mlir("mlir-translate"),
    mlirOpt: toolchain.mlir("mlir-opt"),
  };
  const session = await Session.start({
    dir: options.dir,
    src: options.src,
    tgt: options.tgt,
    llops,
    checker: new AliveTv(toolchain.path("alive-tv"), timeouts.checkDefaultMs, tmp),
    interp: new Llubi(toolchain.path("llubi"), config.timeouts.llubiMs),
    rewriter: new Llrwt(toolchain.path("llrwt"), timeouts.llrwtMs, translators, tmp),
    timeouts,
    config,
    toolchain: built,
    eager: options.eager,
  });
  return { session, llops, config };
}

/**
 * Record the run's verdict, and write its certificate when the run settled.
 * Answers the verdict and the lines that say so.
 */
export function closeRun(session: Session, started: number) {
  const outcome = session.finish();
  const goals = [...session.tree.goals.values()]
    .map((goal) => `${goal.id} ${goal.status}`)
    .join(", ");
  const lines = [`${outcome} in ${Date.now() - started}ms: ${goals}`];
  // Both verdicts are delivered as a package; only "unknown" has nothing to hand over.
  if (outcome !== "unknown") lines.push(certify(session.dir, join(session.dir, "certificate")));
  return { outcome, lines };
}

/** A directory name that sorts by when it was made. */
export function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}
