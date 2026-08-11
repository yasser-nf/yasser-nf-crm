import type { ReportColumn } from "./report-definitions";
import { xmlText } from "./excel.service";

/**
 * PDF, produced by the browser.
 *
 * ADR-011 Decision 1: no PDF library. This emits a self-contained printable
 * HTML document, and the browser's own print-to-PDF turns it into a file.
 *
 * Why that is the right trade rather than a compromise:
 *
 *   The M10 brief separately requires a printable report layout with
 *   professional formatting. A print stylesheet satisfies both requirements
 *   with one artifact instead of maintaining a print view and a parallel PDF
 *   renderer that must be kept looking the same.
 *
 *   Every browser's PDF engine handles fonts, page breaks, headers and
 *   pagination correctly, including scripts a bundled font would not cover.
 *
 * The honest cost: producing the file needs one human click. There is no
 * server-side PDF, so this cannot be attached to a scheduled email. Recorded in
 * docs/REPORTS_MODULE.md rather than described as more than it is.
 */

export const PRINT_MIME = "text/html; charset=utf-8";

export interface PrintMeta {
  readonly title: string;
  readonly description: string;
  readonly generatedAt: Date;
  readonly generatedBy: string;
  readonly filterSummary: readonly string[];
}

/**
 * The print stylesheet.
 *
 * Deliberately not the application's dark theme. 04_UI_GUIDELINES.md fixes dark
 * for the screen; paper is the one surface where that rule does not apply, and
 * printing a dark background wastes ink and reads badly. Print styles are a
 * different medium, not a theme switch.
 */
const PRINT_STYLES = `
  @page { size: A4 landscape; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #111827; background: #ffffff; margin: 0; font-size: 11px;
  }
  header { border-bottom: 2px solid #111827; padding-bottom: 12px; margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 4px; font-weight: 700; }
  .description { color: #4b5563; margin: 0 0 8px; }
  .meta { color: #6b7280; font-size: 10px; display: flex; gap: 16px; flex-wrap: wrap; }
  .filters { margin: 12px 0 0; padding: 8px 12px; background: #f3f4f6; border-radius: 6px; }
  .filters ul { margin: 4px 0 0; padding-left: 16px; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  th { background: #f9fafb; font-weight: 600; border-bottom: 2px solid #d1d5db; }
  td.numeric, th.numeric { text-align: right; font-variant-numeric: tabular-nums; }
  tr { break-inside: avoid; }
  tfoot { color: #6b7280; font-size: 10px; }
  .empty { padding: 32px; text-align: center; color: #6b7280; }
  @media print { .no-print { display: none; } }
`;

/**
 * A complete printable document.
 *
 * `thead { display: table-header-group }` is the load-bearing line: it repeats
 * the column headers on every printed page, without which a multi-page table is
 * unreadable after the first sheet.
 */
export function printableDocument(
  meta: PrintMeta,
  columns: readonly ReportColumn[],
  rows: readonly Record<string, unknown>[],
): string {
  const head = columns
    .map((column) => `<th class="${column.numeric ? "numeric" : ""}">${xmlText(column.label)}</th>`)
    .join("");

  const body = rows
    .map(
      (row) =>
        `<tr>${columns
          .map(
            (column) =>
              `<td class="${column.numeric ? "numeric" : ""}">${xmlText(row[column.key])}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");

  const filters =
    meta.filterSummary.length > 0
      ? `<div class="filters"><strong>Filters applied</strong><ul>${meta.filterSummary
          .map((line) => `<li>${xmlText(line)}</li>`)
          .join("")}</ul></div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${xmlText(meta.title)}</title>
<style>${PRINT_STYLES}</style>
</head>
<body>
<header>
  <h1>${xmlText(meta.title)}</h1>
  <p class="description">${xmlText(meta.description)}</p>
  <div class="meta">
    <span>Generated ${xmlText(meta.generatedAt.toISOString())}</span>
    <span>By ${xmlText(meta.generatedBy)}</span>
    <span>${rows.length} row${rows.length === 1 ? "" : "s"}</span>
  </div>
  ${filters}
</header>

${
  rows.length === 0
    ? `<p class="empty">No rows match these filters.</p>`
    : `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

<script>window.addEventListener("load", function () { window.print(); });</script>
</body>
</html>`;
}

export const pdfService = {
  mime: PRINT_MIME,
  extension: "html",
  document: printableDocument,
} as const;
