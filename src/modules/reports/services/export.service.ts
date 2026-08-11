import "server-only";

import type { AppUser } from "@/lib/auth";
import { csvService } from "./csv.service";
import { excelService } from "./excel.service";
import { pdfService } from "./pdf.service";
import { definitionFor, type ReportKey } from "./report-definitions";
import { reportsService } from "./reports.service";
import {
  describeFilters,
  type ExportFormat,
  type ReportFilters,
} from "../validation/report.schema";

/**
 * Export orchestration.
 *
 * Turns a report into a byte stream, one page of rows at a time. ADR-011
 * Decision 3: this is the only part of the system that streams, and the reason
 * is memory — an export of every profile must not exist in RAM as a whole
 * before the first byte reaches the browser.
 *
 * The shape is deliberately uniform: each format contributes a header, a row
 * serialiser and a footer, so adding a format means adding three small
 * functions rather than another streaming loop.
 */

/** Rows fetched per round trip while streaming. Bounds peak memory. */
export const EXPORT_PAGE_SIZE = 500;

/**
 * A ceiling on total rows.
 *
 * Not a performance limit — the stream would happily continue. It is a guard
 * against an unbounded export becoming an accidental denial of service against
 * the database, and against a runaway loop if a dataset query ever stopped
 * paging correctly.
 */
export const EXPORT_ROW_LIMIT = 100_000;

export interface ExportDescriptor {
  readonly filename: string;
  readonly mime: string;
  readonly stream: ReadableStream<Uint8Array>;
}

function timestamp(now: Date): string {
  return now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/**
 * Builds the export.
 *
 * PDF is the exception to the streaming shape: a printable document is one HTML
 * page whose layout depends on the whole table, so it is assembled in full. It
 * is bounded to a single preview-sized read for that reason — nobody prints a
 * hundred thousand rows, and pretending otherwise would produce a document no
 * browser could paginate.
 */
export async function buildExport(
  key: ReportKey,
  format: ExportFormat,
  filters: ReportFilters,
  actor: AppUser,
  now: Date,
): Promise<ExportDescriptor> {
  const definition = definitionFor(key);
  const columns = definition.columns;
  const encoder = new TextEncoder();
  const base = `${key}-${timestamp(now)}`;

  if (format === "pdf") {
    const page = await reportsService.datasetPage(key, filters, actor, 2000, 0);
    const rows = page.ok ? page.value : [];

    const html = pdfService.document(
      {
        title: definition.title,
        description: definition.description,
        generatedAt: now,
        generatedBy: actor.displayName,
        filterSummary: describeFilters(filters),
      },
      columns,
      rows,
    );

    return {
      filename: `${base}.${pdfService.extension}`,
      mime: pdfService.mime,
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(html));
          controller.close();
        },
      }),
    };
  }

  const isCsv = format === "csv";

  const header = isCsv
    ? csvService.bom + csvService.header(columns) + "\r\n"
    : excelService.header(definition.title, columns);

  const footer = isCsv ? "" : excelService.footer();

  const serialiseRow = (row: Record<string, unknown>): string =>
    isCsv ? csvService.rowFor(row, columns) + "\r\n" : excelService.row(row, columns);

  let offset = 0;
  let emitted = 0;
  let finished = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(header));
    },

    /*
     * `pull` is called only when the consumer is ready for more, which is what
     * makes this genuinely streamed rather than merely chunked: if the client
     * is slow, no further pages are read from the database.
     */
    async pull(controller) {
      if (finished) {
        return;
      }

      const page = await reportsService.datasetPage(key, filters, actor, EXPORT_PAGE_SIZE, offset);

      if (!page.ok) {
        /*
         * The response has already started, so the status cannot change. A
         * comment row is written instead of failing silently — an export that
         * simply stops looks like a complete file that happens to be short.
         */
        controller.enqueue(
          encoder.encode(
            isCsv
              ? `\r\n"Export failed after ${emitted} rows: ${page.error.userMessage}"\r\n`
              : `<Row><Cell><Data ss:Type="String">Export failed after ${emitted} rows</Data></Cell></Row>`,
          ),
        );
        controller.enqueue(encoder.encode(footer));
        controller.close();
        finished = true;
        return;
      }

      for (const row of page.value) {
        controller.enqueue(encoder.encode(serialiseRow(row)));
        emitted += 1;
      }

      offset += EXPORT_PAGE_SIZE;

      const exhausted = page.value.length < EXPORT_PAGE_SIZE;

      if (exhausted || emitted >= EXPORT_ROW_LIMIT) {
        if (!exhausted) {
          controller.enqueue(
            encoder.encode(
              isCsv
                ? `\r\n"Truncated at ${EXPORT_ROW_LIMIT} rows. Narrow the filters."\r\n`
                : `<Row><Cell><Data ss:Type="String">Truncated at ${EXPORT_ROW_LIMIT} rows</Data></Cell></Row>`,
            ),
          );
        }

        controller.enqueue(encoder.encode(footer));
        controller.close();
        finished = true;
      }
    },
  });

  return {
    filename: `${base}.${isCsv ? csvService.extension : excelService.extension}`,
    mime: isCsv ? csvService.mime : excelService.mime,
    stream,
  };
}

export const exportService = { build: buildExport, pageSize: EXPORT_PAGE_SIZE } as const;
