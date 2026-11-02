import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Program IDs and trajectory chains require synchronous, incremental SHA-256.
export function createHash(algorithm: string) {
  if (algorithm !== "sha256") throw new Error(`Unsupported hash: ${algorithm}`);

  const hash = sha256.create();
  const result = {
    update(text: string) {
      hash.update(new TextEncoder().encode(text));
      return result;
    },

    digest(encoding: string) {
      if (encoding !== "hex") throw new Error(`Unsupported hash encoding: ${encoding}`);
      return bytesToHex(hash.digest());
    },
  };

  return result;
}
