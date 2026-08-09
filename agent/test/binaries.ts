// Where the tests find the binaries they drive.
//
// In order: an environment variable, so one run can point at a build tree
// without touching anything; then this machine's configuration, which is what
// the runner and the agent use, so a test drives the same binary a run would;
// then the places we build and install into, so a fresh clone with no
// configuration still tests what it just built. Anything not found that way is
// left as a bare name for PATH, and the suite that needs it skips when it is
// not there.
import { join } from "node:path";
import { binaryPath, loadConfig, repoRoot } from "../src/config.ts";

const config = loadConfig();

export function binary(name: string, env: string, ...fallbacks: string[]): string {
  const configured = config.binaries[name] ? binaryPath(config, name) : undefined;
  const candidates = [process.env[env], configured, ...fallbacks];
  return candidates.find((path) => path && Bun.file(path).size > 0) ?? name;
}

/** llops, which most suites need, preferring what was just built. */
export function llopsBinary(): string {
  return binary(
    "llops",
    "LLOPS",
    join(repoRoot(), "build", "llops", "llops"),
    join(repoRoot(), "deps", "prefix", "bin", "llops"),
  );
}
