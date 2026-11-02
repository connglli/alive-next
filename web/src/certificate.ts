// Use the native manifest builder; only the package's file destination differs.
import { manifestOf } from "../../engine/cert/manifest.ts";
import { derive, verdict } from "../../engine/core/state/goals.ts";
import { sha256 } from "../../engine/core/state/hash.ts";
import { parse } from "../../engine/core/state/trajectory.ts";
import type { ReportSource } from "./protocol.ts";

export function certificatePackage(source: ReportSource, checker: string) {
  const entries = parse(source.trajectory.join(""));
  const tree = derive(entries);
  const outcome = verdict(tree);
  const files: Record<string, string> = {};
  if (outcome === "unknown") return { outcome, files };

  const [manifest, programs] = manifestOf(entries, tree);
  files["manifest.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  files["check.py"] = checker;
  for (const hash of programs) {
    const text = source.programs[hash];
    if (text === undefined) throw new Error(`Missing certificate program ${hash}`);
    if (sha256(text) !== hash) throw new Error(`Certificate program ${hash} has been altered`);
    files[`programs/${hash}.ll`] = text;
  }
  return { outcome, files };
}
