// The program store: every version of every program, addressed by content.
//
// A program is written under the sha256 of its canonical text, so the file
// name is the integrity check and two programs that differ only in names are
// one file. Nothing is ever overwritten, which is what makes reverting a
// bookkeeping change rather than an undo.
//
// Canonicalization happens here rather than at each call site, because "the
// store holds canonical text" is an invariant worth making structural: a rule
// repeated at nineteen call sites is a rule that rots.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Llops } from "../drivers/llops.ts";
import { sha256 } from "./hash.ts";

/** Turns IR text into the canonical text the store keeps, `llops canon`. */
export type Canonicalize = (text: string) => Promise<string>;

/**
 * The canonicalizer every store outside a unit test uses. A program llops will
 * not parse cannot be stored at all, so a store never holds text no later tool
 * can read.
 */
export function canonWith(llops: Llops): Canonicalize {
  return async (text: string) => {
    const result = await llops.canon(text);
    if (!result.ok) throw new Error(`llops canon: ${result.code}, ${result.message}`);
    return result.module;
  };
}

/** Thrown when a stored file is not the program its name claims. */
export class StoreCorrupt extends Error {
  constructor(readonly hash: string) {
    super(`store: ${hash}.ll does not hash to its name`);
    this.name = "StoreCorrupt";
  }
}

export class Store {
  constructor(
    private readonly dir: string,
    private readonly canonicalize: Canonicalize,
  ) {
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Put a program in the store and answer with its hash. Writing the same
   * program twice is one file and the same hash, so a caller never has to ask
   * whether something is already there.
   */
  async put(text: string): Promise<string> {
    const canonical = await this.canonicalize(text);
    const hash = sha256(canonical);
    const path = this.pathOf(hash);
    // The name is the hash, so an existing file is already this program and
    // rewriting it would only risk tearing it. A new one lands by rename, so a
    // crash mid-write leaves a stray temporary rather than half a program
    // under a name that promises the whole of it.
    if (!existsSync(path)) {
      const partial = `${path}.${process.pid}.part`;
      writeFileSync(partial, canonical, "utf8");
      renameSync(partial, path);
    }
    return hash;
  }

  /** The program with this hash, or a throw when it is absent or altered. */
  get(hash: string): string {
    const text = readFileSync(this.pathOf(hash), "utf8");
    // Verification is free here: the name says what the content must hash to.
    if (sha256(text) !== hash) throw new StoreCorrupt(hash);
    return text;
  }

  has(hash: string): boolean {
    return existsSync(this.pathOf(hash));
  }

  /** Every hash in the store, for the certificate to copy what it needs. */
  hashes(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".ll"))
      .map((name) => name.slice(0, -3))
      .sort();
  }

  private pathOf(hash: string): string {
    return join(this.dir, `${hash}.ll`);
  }
}
