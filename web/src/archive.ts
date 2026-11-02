import { strToU8, zipSync } from "fflate";
import { certificatePackage } from "./certificate.ts";
import type { ReportSource } from "./protocol.ts";

/** Keep the native session layout so scripts/visualize.py can read an extracted ZIP. */
export function sessionArchive(
  source: ReportSource,
  module: string,
  html: string,
  checker: string,
) {
  const files: Record<string, Uint8Array> = {
    "module.ll": strToU8(module),
    "session/trajectory.jsonl": strToU8(source.trajectory.join("")),
    "session/session.html": strToU8(html),
  };
  for (const [hash, text] of Object.entries(source.programs)) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid stored program name");
    files[`session/store/${hash}.ll`] = strToU8(text);
  }
  const certificate = certificatePackage(source, checker);
  for (const [path, text] of Object.entries(certificate.files))
    files[`session/certificate/${path}`] = strToU8(text);
  const instructions =
    certificate.outcome === "unknown"
      ? "No certificate is available: the recorded root goal is not proved or refuted.\n"
      : "Certificate: session/certificate/\n\nReplay with Python 3 and native project tools on PATH:\n  python3 session/certificate/check.py\n\nUse --alive-tv and --llops to select native binaries explicitly.\nUse --src and --tgt to bind replay to trusted source and target files.\n";
  files["README.txt"] = strToU8(
    `Outcome: ${certificate.outcome}\n\nInput: module.ll\nReport: session/session.html\nSession: session/trajectory.jsonl and session/store/\n\n${instructions}`,
  );
  return zipSync(files, { level: 6 });
}
