import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { isEncryptionConfigured, serverEnv } from "@/config/env.server";
import { ConfigurationError, UnexpectedError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";

/**
 * Reversible encryption for stored credentials.
 *
 * ADR-005 Decision 4. 03_DATABASE.md requires encrypted passwords; the business
 * must also be able to read them back to send to customers, so this is
 * encryption and never hashing.
 *
 * AES-256-GCM is authenticated: a tampered ciphertext fails to decrypt rather
 * than silently producing wrong plaintext. That matters for a value the business
 * will paste into a customer's chat.
 *
 * The key never enters a SQL statement, which is the reason pgcrypto was
 * rejected — its key would appear in query logs and pg_stat_statements.
 */

const ALGORITHM = "aes-256-gcm";

/** 96 bits is the GCM-recommended IV length. */
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

/**
 * Stored format, colon-delimited base64:
 *
 *   v1:<iv>:<authTag>:<ciphertext>
 *
 * The version prefix exists so a future algorithm change can be rolled out
 * without guessing how an existing row was encrypted.
 */
const FORMAT_VERSION = "v1";
const SEGMENT_COUNT = 4;

function readKey(): Result<Buffer> {
  if (!isEncryptionConfigured()) {
    return fail(
      new ConfigurationError("ENCRYPTION_KEY is still the published placeholder", {
        userMessage:
          "Account passwords cannot be stored until encryption is configured. Please contact your administrator.",
      }),
    );
  }

  return ok(Buffer.from(serverEnv.ENCRYPTION_KEY, "hex"));
}

/**
 * Encrypts a plaintext secret.
 *
 * The same input produces different output every time, because each ciphertext
 * carries a fresh random IV. This is correct, and it is also why the column
 * cannot be searched with an equality comparison.
 */
export function encryptSecret(plaintext: string): Result<string> {
  const key = readKey();

  if (!key.ok) {
    return key;
  }

  try {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key.value, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });

    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

    return ok(
      [
        FORMAT_VERSION,
        iv.toString("base64"),
        cipher.getAuthTag().toString("base64"),
        ciphertext.toString("base64"),
      ].join(":"),
    );
  } catch (caught) {
    /*
     * The message is deliberately generic. A crypto error can echo key material
     * or buffer contents, and 01_MASTER_RULES.md forbids exposing internals.
     */
    return fail(new UnexpectedError("Encryption failed", { cause: caught }));
  }
}

/** Decrypts a value produced by `encryptSecret`. */
export function decryptSecret(encrypted: string): Result<string> {
  const key = readKey();

  if (!key.ok) {
    return key;
  }

  const segments = encrypted.split(":");

  if (segments.length !== SEGMENT_COUNT || segments[0] !== FORMAT_VERSION) {
    return fail(
      new UnexpectedError("Stored ciphertext is not in the expected format", {
        context: { expectedVersion: FORMAT_VERSION, segmentCount: segments.length },
      }),
    );
  }

  const [, ivBase64, authTagBase64, ciphertextBase64] = segments;

  if (ivBase64 === undefined || authTagBase64 === undefined || ciphertextBase64 === undefined) {
    return fail(new UnexpectedError("Stored ciphertext is missing a segment"));
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key.value, Buffer.from(ivBase64, "base64"), {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });

    decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextBase64, "base64")),
      decipher.final(),
    ]);

    return ok(plaintext.toString("utf8"));
  } catch (caught) {
    /*
     * Reached when the authentication tag does not match — the row was tampered
     * with, or ENCRYPTION_KEY has changed since it was written. Both are serious
     * and neither should be described to a user.
     */
    return fail(
      new UnexpectedError("Decryption failed: data was tampered with or the key has changed", {
        cause: caught,
      }),
    );
  }
}
