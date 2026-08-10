// The one hash the session uses.
//
// A program is named by the hash of its canonical text and a trajectory line
// by the hash of the line before it, so both the store and the log are
// tamper-evident with one primitive and no key.
import { createHash } from "node:crypto";

/** Lowercase hex sha256 of the UTF-8 bytes of `text`. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
