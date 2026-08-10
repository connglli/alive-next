// Writing the certificate a verified session earned.
//
//     bun run cert sessions/<id> [<directory>]
//
// The package is what someone else replays: the programs the proof refers to,
// the manifest that says how they compose, and the checker that reruns it. It
// is assembled from the session directory alone, so a run that has already
// finished can still be certified.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../core/config.ts";
import { derive } from "../core/state/goals.ts";
import { Store } from "../core/state/store.ts";
import { parse } from "../core/state/trajectory.ts";
import { manifestOf, NotCertifiable } from "./manifest.ts";

/** Build the package, and answer with where it landed. */
export function certify(session: string, out: string): string {
  const entries = parse(readFileSync(join(session, "trajectory.jsonl"), "utf8"));
  const [manifest, programs] = manifestOf(entries, derive(entries));

  // The store verifies each program against its name as it reads it, so a
  // package cannot be built out of a store that has been altered.
  const store = new Store(join(session, "store"), async (text) => text);
  mkdirSync(join(out, "programs"), { recursive: true });
  for (const hash of programs) {
    writeFileSync(join(out, "programs", `${hash}.ll`), store.get(hash), "utf8");
  }
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  copyFileSync(join(repoRoot(), "scripts", "check.py"), join(out, "check.py"));
  return out;
}

if (import.meta.main) {
  const [session, out] = process.argv.slice(2);
  if (!session) {
    console.error("usage: bun run cert <session> [<directory>]");
    process.exit(2);
  }
  try {
    console.log(certify(session, out ?? join(session, "certificate")));
  } catch (error) {
    if (!(error instanceof NotCertifiable)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
