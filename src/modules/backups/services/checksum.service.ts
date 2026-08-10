import { createHash, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";

/**
 * Checksum service.
 *
 * SHA-256, as the M07 brief requires. Node's crypto rather than a dependency:
 * 01_MASTER_RULES.md prefers native APIs, and a hashing library would be a
 * supply-chain risk taken on for no capability.
 *
 * No `server-only` import, and no database access, so this is unit testable —
 * the checksum is the one thing in the module that must be provably correct,
 * because everything else trusts it.
 */

export const CHECKSUM_ALGORITHM = "sha256";

/** Hashes a buffer already in memory. Used for imports, which arrive whole. */
export function checksumOf(content: Buffer | string): string {
  return createHash(CHECKSUM_ALGORITHM).update(content).digest("hex");
}

/**
 * Hashes a stream without buffering it.
 *
 * The performance requirement: a large backup must never be held in memory just
 * to be hashed. The digest updates chunk by chunk as bytes flow past.
 */
export async function checksumOfStream(stream: Readable): Promise<string> {
  const hash = createHash(CHECKSUM_ALGORITHM);

  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }

  return hash.digest("hex");
}

/**
 * Compares two checksums without leaking timing information.
 *
 * A plain `===` would short-circuit at the first differing character. That is a
 * side channel, and while forging a backup checksum is an unlikely attack
 * against a private CRM, constant-time comparison costs nothing here.
 *
 * Length is checked first because timingSafeEqual throws on mismatched buffers.
 */
export function checksumMatches(expected: string, actual: string): boolean {
  if (typeof expected !== "string" || typeof actual !== "string") {
    return false;
  }

  if (expected.length !== actual.length || expected.length === 0) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}

export const checksumService = {
  algorithm: CHECKSUM_ALGORITHM,
  of: checksumOf,
  ofStream: checksumOfStream,
  matches: checksumMatches,
} as const;
