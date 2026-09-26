import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";

import { canonicalJson, contentLines, type BackupData } from "./backup-format";

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

/**
 * An incremental content hash (M07): fed the canonical lines of a backup as
 * they are written (see `contentLines` in backup-format.ts), so the writer can
 * hash a dataset it never holds whole.
 */
export function createContentHash(): { update(line: string): void; digest(): string } {
  const hash = createHash(CHECKSUM_ALGORITHM);

  return {
    update(line: string) {
      hash.update(line, "utf8");
    },
    digest() {
      return hash.digest("hex");
    },
  };
}

/** The content hash of a parsed backup, recomputed from its data. */
export function contentSha256(tables: readonly string[], data: BackupData): string {
  const hash = createContentHash();

  for (const line of contentLines(tables, data)) {
    hash.update(line);
  }

  return hash.digest();
}

/**
 * The manifest's authentication code (M07 review): HMAC-SHA256, under the
 * backup key, of the canonical manifest WITHOUT its own `contentMac`. It
 * covers every manifest field — versions, tables, row counts, the content
 * hash, dates, type — so editing any of them, or the data behind the content
 * hash, without the key is detected.
 */
export function manifestMac(manifest: Readonly<Record<string, unknown>>, key: Buffer): string {
  const { contentMac: _mac, ...signed } = manifest;

  return createHmac(CHECKSUM_ALGORITHM, key).update(canonicalJson(signed), "utf8").digest("hex");
}

export const checksumService = {
  algorithm: CHECKSUM_ALGORITHM,
  of: checksumOf,
  ofStream: checksumOfStream,
  matches: checksumMatches,
  createContentHash,
  contentSha256,
  manifestMac,
} as const;
