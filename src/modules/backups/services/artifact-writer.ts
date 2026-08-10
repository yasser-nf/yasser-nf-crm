import "server-only";

import { createGzip, gunzipSync } from "node:zlib";

import { datasetRepository } from "../repositories/dataset.repository";
import { BACKUP_TABLES, type BackupManifest } from "./backup-format";

/**
 * Builds and reads the compressed artifact.
 *
 * The performance requirement in the M07 brief is that large backups stream
 * rather than being loaded whole. This is where that happens, and it is worth
 * being precise about what "streaming" means here:
 *
 *   Rows are read one page at a time and pushed straight into a gzip stream.
 *   Only one page of rows and the compressed output ever exist at once — the
 *   full uncompressed dataset is never materialised, in memory or anywhere else.
 *
 * The compressed result is still assembled into a Buffer before upload, because
 * the Supabase Storage client takes a body rather than a Node stream. For a CRM
 * dump that is a few megabytes compressed; the part that would actually have
 * exhausted memory — the uncompressed JSON — never exists.
 */

/** Rows fetched per query while writing. Bounds peak memory. */
const PAGE_SIZE = 500;

export interface WrittenArtifact {
  readonly body: Buffer;
  readonly rowCounts: Record<string, number>;
}

/**
 * Streams every backed-up table into one gzipped JSON document.
 *
 * The JSON is written by hand rather than with JSON.stringify over a complete
 * object, because building that object is exactly the thing this avoids.
 */
export async function writeArtifact(
  manifest: Omit<BackupManifest, "rowCounts">,
): Promise<WrittenArtifact> {
  const gzip = createGzip();
  const chunks: Buffer[] = [];

  gzip.on("data", (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<void>((resolve, reject) => {
    gzip.on("end", resolve);
    gzip.on("error", reject);
  });

  const rowCounts: Record<string, number> = {};

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

  await write(`{"manifest":`);
  /* Row counts are only known after the tables are read, so they are appended last. */
  const manifestPlaceholder = { ...manifest };
  await write(JSON.stringify(manifestPlaceholder));
  await write(`,"data":{`);

  let firstTable = true;

  for (const spec of BACKUP_TABLES) {
    if (!firstTable) {
      await write(",");
    }
    firstTable = false;

    await write(`${JSON.stringify(spec.table)}:[`);

    let offset = 0;
    let written = 0;

    for (;;) {
      const page = await datasetRepository.readPage(spec.table, offset, PAGE_SIZE);

      if (!page.ok) {
        gzip.destroy();
        throw page.error;
      }

      for (const row of page.value) {
        await write(written === 0 ? JSON.stringify(row) : `,${JSON.stringify(row)}`);
        written += 1;
      }

      if (page.value.length < PAGE_SIZE) {
        break;
      }

      offset += PAGE_SIZE;
    }

    rowCounts[spec.table] = written;
    await write("]");
  }

  await write(`},"rowCounts":${JSON.stringify(rowCounts)}}`);

  gzip.end();
  await finished;

  return { body: Buffer.concat(chunks), rowCounts };
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

  return {
    ...document,
    manifest: {
      ...(manifest as Record<string, unknown>),
      rowCounts: (manifest as Record<string, unknown>)["rowCounts"] ?? document["rowCounts"] ?? {},
    },
  };
}
