import "server-only";

import { createGzip, gunzipSync } from "node:zlib";

import { databaseAdapter } from "@/lib/database";
import type { Result } from "@/types/result";
import { readPageWith } from "../repositories/dataset.repository";
import { BACKUP_TABLES, canonicalJson, type BackupManifest } from "./backup-format";
import { createContentHash } from "./checksum.service";

/**
 * Builds and reads the compressed artifact.
 *
 * STREAMING. Rows are read one page at a time and pushed straight into a gzip
 * stream. Only one page of rows and the compressed output ever exist at once —
 * the full uncompressed dataset is never materialised. The compressed result
 * is assembled into a Buffer before upload, because the Supabase Storage
 * client takes a body rather than a Node stream.
 *
 * CONSISTENCY (M07). Every page of every table is read inside ONE
 * `readSnapshot` transaction — REPEATABLE READ, READ ONLY — so the whole
 * backup shows the database at a single instant. Before M07 each page was its
 * own query, and a sale committed between reading `accounts` and reading
 * `profiles` could leave a profile in the backup whose account was not.
 *
 * INTEGRITY (M07). Each row is fed, in canonical form, into a SHA-256 as it is
 * written; the digest goes into the file as `contentSha256`. See `contentLines`
 * for the exact bytes hashed.
 */

/** Rows fetched per query while writing. Bounds peak memory. */
const PAGE_SIZE = 500;

export interface WrittenArtifact {
  readonly body: Buffer;
  readonly rowCounts: Record<string, number>;
  readonly contentSha256: string;
}

/**
 * Streams every backed-up table into one gzipped JSON document, from one
 * consistent snapshot.
 *
 * The JSON is written by hand rather than with JSON.stringify over a complete
 * object, because building that object is exactly the thing this avoids. The
 * gzip stream is created INSIDE the transaction callback: the adapter retries
 * a failed transaction from the start, and a retry must not append to the
 * half-written output of the attempt that failed.
 */
export async function writeArtifact(
  manifest: Omit<BackupManifest, "rowCounts" | "contentSha256">,
): Promise<Result<WrittenArtifact>> {
  return databaseAdapter.readSnapshot("backups.writeArtifact", async (executor) => {
    const gzip = createGzip();
    const chunks: Buffer[] = [];

    gzip.on("data", (chunk: Buffer) => chunks.push(chunk));

    const finished = new Promise<void>((resolve, reject) => {
      gzip.on("end", resolve);
      gzip.on("error", reject);
    });

    /*
     * Backpressure is respected: when the gzip stream's buffer is full, write()
     * returns false and we wait for drain. Ignoring that is how a "streaming"
     * writer quietly buffers the entire output anyway.
     */
    const write = (text: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (gzip.write(text)) {
          resolve();
          return;
        }

        gzip.once("drain", resolve);
        gzip.once("error", reject);
      });

    const content = createContentHash();
    const rowCounts: Record<string, number> = {};

    try {
      await write(`{"manifest":`);
      /* Counts and the content hash are only known at the end: they are appended last. */
      await write(JSON.stringify(manifest));
      await write(`,"data":{`);

      let firstTable = true;

      for (const spec of BACKUP_TABLES) {
        if (!firstTable) {
          await write(",");
        }
        firstTable = false;

        await write(`${JSON.stringify(spec.table)}:[`);
        content.update(`table:${spec.table}\n`);

        let offset = 0;
        let written = 0;

        for (;;) {
          const page = await readPageWith(executor, spec.table, offset, PAGE_SIZE);

          for (const row of page) {
            await write(written === 0 ? JSON.stringify(row) : `,${JSON.stringify(row)}`);
            content.update(`${canonicalJson(row)}\n`);
            written += 1;
          }

          if (page.length < PAGE_SIZE) {
            break;
          }

          offset += PAGE_SIZE;
        }

        rowCounts[spec.table] = written;
        await write("]");
      }

      const contentSha256 = content.digest();

      await write(
        `},"rowCounts":${JSON.stringify(rowCounts)},"contentSha256":${JSON.stringify(contentSha256)}}`,
      );

      gzip.end();
      await finished;

      return { body: Buffer.concat(chunks), rowCounts, contentSha256 };
    } catch (caught) {
      gzip.destroy();
      throw caught;
    }
  });
}

/**
 * Reads an artifact back, normalising its shape.
 *
 * Decompressed whole, unlike writing. A restore has to hold the dataset anyway
 * to diff it and apply it in one transaction, so streaming the read would save
 * nothing and complicate the atomicity guarantee that matters more.
 *
 * The file carries `rowCounts` as a sibling of `manifest` rather than inside it,
 * because counts are only known once every table has been written and the
 * manifest is emitted first. That is a property of streaming, not of the format,
 * so it is folded back into the manifest here — callers see one shape and never
 * have to know the writer's ordering constraint.
 */
export function readArtifact(body: Buffer): unknown {
  const parsed: unknown = JSON.parse(gunzipSync(body).toString("utf8"));

  if (typeof parsed !== "object" || parsed === null) {
    return parsed;
  }

  const document = parsed as Record<string, unknown>;
  const manifest = document["manifest"];

  if (typeof manifest !== "object" || manifest === null) {
    return parsed;
  }

  const fields = manifest as Record<string, unknown>;

  return {
    ...document,
    manifest: {
      ...fields,
      rowCounts: fields["rowCounts"] ?? document["rowCounts"] ?? {},
      /* v2 writes the content hash in the trailer, for the same reason as the counts. */
      ...((fields["contentSha256"] ?? document["contentSha256"])
        ? { contentSha256: fields["contentSha256"] ?? document["contentSha256"] }
        : {}),
    },
  };
}
