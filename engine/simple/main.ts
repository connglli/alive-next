// Running the simple searcher by hand. It writes the same session directory the
// agent and the examples write: the trajectory, the store, and the certificate
// when the run earns one. Each switch turns one of the search's moves off.
import { join } from "node:path";
import { readArgs, readCount, readPair, tryOrExit } from "../core/args.ts";
import { repoRoot } from "../core/config.ts";
import { closeRun, stamp, startRun } from "../core/run.ts";
import { DEFAULT_LIMITS, type Limits } from "./limits.ts";
import { search } from "./search.ts";

const USAGE = `usage: bun run simple [options] <src.ll> <tgt.ll> [<directory>]

      --seconds <n>       stop after n seconds, an hour by default
      --cuts <n>          allow n cuts (a region counts once), 16 by default
      --no-stages         do not step through the optimizer's stages
      --no-steps          do not rewrite the src, only cut and check
      --no-windows        check each step on the whole function
      --no-preconditions  do not ask what the analyses know
      --no-cuts           do not cut
  -h, --help`;

const flags = tryOrExit(() => parseArgs(process.argv.slice(2)));
if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}
const { src, tgt, where } = readPair(flags.rest);
const dir = where ?? join(repoRoot(), "sessions", `simple-${stamp()}`);
const { session, llops } = await startRun({ src, tgt, dir });
const started = Date.now();
await search(session, llops, flags.limits);
console.log(`  ${dir}`);
for (const line of closeRun(session, started).lines) console.log(`  ${line}`);

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
    else if (arg === "--no-stages") flags.limits.stages = false;
    else if (arg === "--no-steps") flags.limits.steps = false;
    else if (arg === "--no-windows") flags.limits.windows = false;
    else if (arg === "--no-preconditions") flags.limits.facts = false;
    else if (arg === "--no-cuts") flags.limits.cuts = 0;
    else if (arg === "-h" || arg === "--help") flags.help = true;
    else return false;
    return true;
  });
  return flags;
}
