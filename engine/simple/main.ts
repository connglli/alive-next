// Running the simple searcher by hand. It writes the same session directory the
// agent and the examples write: the trajectory, the store, and the certificate
// when the run earns one. Each switch turns one of the search's moves off.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readArgs, readCount, readPair, tryOrExit } from "../core/args.ts";
import { repoRoot } from "../core/config.ts";
import { closeRun, stamp, startRun } from "../core/run.ts";
import { DEFAULT_LIMITS, type Limits } from "./limits.ts";
import { search } from "./search.ts";

const USAGE = `usage: bun run simple [options] <src.ll> <tgt.ll> [<directory>]

      --seconds <n>       end the whole run after n seconds, an hour by default
      --cuts <n>          at least n cuts (a region counts once), 16 by default
      --unfolds <n>       allow n unfolds per loop cut, 4 by default
      --no-stages         do not step through the optimizer's stages
      --no-steps          do not rewrite the src, only cut and check
      --no-rules          do not step the src by the verified rules
      --no-windows        check each step on the whole function
      --no-preconditions  give windows and cuts no preconditions
      --no-cuts           do not cut
  -h, --help`;

const started = Date.now();
const flags = tryOrExit(() => parseArgs(process.argv.slice(2)));
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}
const { src, tgt, where } = readPair(flags.rest);
const dir = where ?? join(repoRoot(), "sessions", `simple-${stamp()}`);
const { session, llops } = await startRun({ src, tgt, dir });
console.log(`  ${dir}`);
// The time given bounds the whole run: when it is up, the checks still
// running are stopped, since they would outlive the process, and the run
// closes with what its log holds.
setTimeout(
  () => {
    console.log("  out of time");
    spawnSync("pkill", ["-P", String(process.pid)]);
    close();
    process.exit(0);
  },
  started + flags.limits.ms - Date.now(),
).unref();
try {
  await search(session, llops, flags.limits);
} catch (error) {
  // A search that stops on an error still leaves its session and verdict.
  console.log(`  stopped: ${(error as Error).message}`);
}
close();

/** Close the run and say how it went. */
function close() {
  for (const line of closeRun(session, started).lines) console.log(`  ${line}`);
}

interface Flags {
  limits: Limits;
  help?: boolean;
  rest: string[];
}

/** The simple searcher's command line. */
function parseArgs(args: string[]): Flags {
  const flags: Flags = { limits: { ...DEFAULT_LIMITS }, rest: [] };
  flags.rest = readArgs(args, (arg, value) => {
    if (arg === "--seconds") flags.limits.ms = readCount(arg, value()) * 1000;
    else if (arg === "--cuts") flags.limits.cuts = readCount(arg, value());
    else if (arg === "--unfolds") flags.limits.unfolds = readCount(arg, value());
    else if (arg === "--no-stages") flags.limits.stages = false;
    else if (arg === "--no-steps") flags.limits.steps = false;
    else if (arg === "--no-rules") flags.limits.rules = false;
    else if (arg === "--no-windows") flags.limits.windows = false;
    else if (arg === "--no-preconditions") flags.limits.facts = false;
    else if (arg === "--no-cuts") flags.limits.cuts = 0;
    else if (arg === "-h" || arg === "--help") flags.help = true;
    else return false;
    return true;
  });
  return flags;
}
