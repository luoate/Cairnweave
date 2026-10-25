import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";

const HASH_CHUNK_BYTES = 1024 * 1024;

/** Streams a file into SHA-256 without loading it into memory. Follows symlinks. */
export function hashFileSha256(path: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes <= 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}
