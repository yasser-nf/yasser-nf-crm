import "server-only";

import { hkdfSync } from "node:crypto";

import { serverEnv } from "@/config/env.server";

/**
 * The key that authenticates backup files (M07 review).
 *
 * WHY. The content hash proves a file's data matches its manifest, but it is
 * an ordinary SHA-256: anyone holding an exported file can edit the data,
 * recompute the hash, recompress and import it. The stored-file checksum does
 * not help there — an imported file has no trusted copy to compare with. An
 * HMAC over the manifest (which carries the content hash) does: without this
 * key, a valid signature cannot be produced.
 *
 * WHICH KEY. Derived with HKDF from ENCRYPTION_KEY rather than a new secret.
 * No second key system: a backup is only useful on a deployment holding
 * ENCRYPTION_KEY anyway, because its account passwords are encrypted with it.
 * The derivation label separates this use from encryption — the MAC key is
 * never the encryption key.
 */

const LABEL = "ynf-crm/backup-manifest-mac/v1";

let cached: Buffer | null = null;

export function backupMacKey(): Buffer {
  if (!cached) {
    cached = Buffer.from(
      hkdfSync("sha256", Buffer.from(serverEnv.ENCRYPTION_KEY, "hex"), Buffer.alloc(0), LABEL, 32),
    );
  }

  return cached;
}
