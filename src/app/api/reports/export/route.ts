import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import {
  exportFormatSchema,
  exportService,
  isReportKey,
  parseFilters,
  reportsService,
} from "@/modules/reports";

/**
 * Report export.
 *
 * The one Route Handler in the application, and a deliberate exception to
 * ADR-006 Decision 3 — recorded in ADR-011 Decision 3.
 *
 * Server Actions were the wrong tool here and not by a small margin: an action
 * buffers its entire return value into the RSC payload, so a large export would
 * be held in memory twice and capped by the action size limit. A Route Handler
 * can return a ReadableStream, which is the only way "large exports must
 * stream" is achievable at all.
 *
 * The exception is narrow on purpose. This route contains no business logic: it
 * resolves the caller, validates input, and hands off to the export service.
 * Authorization is checked inside `reportsService.datasetPage` on every page,
 * so a revoked session stops the stream rather than draining it.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const actor = await getCurrentUser();

  if (!actor) {
    /*
     * Rarely reached: middleware protects every route and redirects an
     * unauthenticated request to /login before it arrives here. Verified — an
     * anonymous GET to this URL returns 307, not 401.
     *
     * Kept anyway as this route's own guard. It does not depend on the
     * middleware matcher continuing to cover /api, and a 401 is the right
     * answer for a download endpoint if it ever stops.
     */
    return new Response("Not authenticated", { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const report = params.get("report") ?? "";

  if (!isReportKey(report)) {
    return new Response("Unknown report", { status: 400 });
  }

  const format = exportFormatSchema.safeParse(params.get("format") ?? "csv");

  if (!format.success) {
    return new Response("Unsupported format", { status: 400 });
  }

  /* Permission is checked before a single row is read, and again per page. */
  if (!reportsService.canRun(actor, report)) {
    return new Response("Not permitted", { status: 403 });
  }

  const filters = parseFilters(Object.fromEntries(params.entries()));

  const descriptor = await exportService.build(report, format.data, filters, actor, new Date());

  /*
   * PDF is served inline, not as an attachment. The printable document carries
   * a script that opens the browser's print dialogue on load, and that only
   * runs if the page is rendered — downloading it would produce an .html file
   * the person then has to find and open themselves.
   */
  const disposition =
    format.data === "pdf"
      ? `inline; filename="${descriptor.filename}"`
      : `attachment; filename="${descriptor.filename}"`;

  return new Response(descriptor.stream, {
    status: 200,
    headers: {
      "Content-Type": descriptor.mime,
      "Content-Disposition": disposition,
      /*
       * A report reflects the database at the moment it ran. Caching one would
       * hand somebody yesterday's figures with today's timestamp on them.
       */
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
