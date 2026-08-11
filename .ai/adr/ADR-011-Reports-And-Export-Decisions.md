# ADR-011
# Reports And Export Decisions

Status: ACCEPTED

Date: 2026-08-11

Owner: Yasser Saidi

Amends: 02_ARCHITECTURE.md, ADR-001, ADR-006

---

# Context

Milestone M10 builds the Reports & Export engine.

Three questions had no answer in any document, and all three touch decisions
that are frozen. They were put to the project owner and approved on 2026-08-11.

---

# Decision 1 — No New Dependencies For Export

## Decision

CSV, Excel and PDF are produced without adding a single package.

CSV — hand-written, RFC 4180 quoting.

Excel — SpreadsheetML 2003, a single XML document Excel, LibreOffice and
Numbers all open natively.

PDF — a printable HTML document, converted by the browser's own print-to-PDF.

## Why

ADR-001 fixed the technology stack and 01_MASTER_RULES.md says to install only
dependencies that provide clear value and to prefer native APIs.

A true `.xlsx` is a ZIP of a dozen XML parts and cannot be produced honestly
without a library or a ZIP implementation. SpreadsheetML gives what CSV cannot —
real cell types, so a number stays a number and a phone number is not reformatted
into scientific notation — for the cost of one XML writer.

For PDF, the M10 brief separately requires a printable report layout with
professional formatting. A print stylesheet satisfies both requirements with one
artifact instead of a print view plus a parallel PDF renderer that must be kept
looking identical. Every browser's PDF engine already handles fonts, pagination
and page breaks correctly.

## Accepted costs

The Excel file is `.xls` (SpreadsheetML), not `.xlsx`. Excel opens it and may
warn about the extension on some configurations.

PDF requires one human click. There is no server-side PDF, so a report cannot be
attached to a scheduled email. Recorded in docs/REPORTS_MODULE.md rather than
described as more than it is.

---

# Decision 2 — Saved Presets Get A Table

## Decision

`report_presets`, owned by a user, holding filters, columns, sort and export
format.

## Why, as the M10 brief requires

A preset is a per-user row that accumulates — one person may keep a dozen.

`settings` was the alternative and is a singleton by construction: a unique
index pins it to one row. Every user's presets would share one JSON blob with no
ownership, no way to enforce ownership, and concurrent saves clobbering each
other.

Rows with an owner are what a table is for.

## Security

Narrower than any previous table. The RLS policy filters by ownership rather
than by role — `user_id = auth.uid()` — because a preset belongs to one person
and even a Super Admin has no business reading somebody else's saved views
through the API.

REVOKE, RLS and the policy are applied in the same migration that creates the
table, and a verified down migration exists.

---

# Decision 3 — Export Uses A Route Handler

## Context

The M10 brief requires large exports to stream.

ADR-006 Decision 3 made Server Actions the transport layer, and
02_ARCHITECTURE.md states the app directory holds layouts, routes, providers and
page composition — nothing else.

## Decision

One Route Handler: `app/api/reports/export/route.ts`. It returns a
`ReadableStream`.

This is an exception to ADR-006 Decision 3, and it is the only one.

## Why an action could not do it

A Server Action buffers its entire return value into the RSC payload. A large
export would be held in memory twice and capped by the action size limit.
Streaming is not achievable through that transport at all — this is not a
preference between two workable options.

## How the exception is kept narrow

The route contains no business logic. It resolves the caller, validates input,
and hands off to the export service.

Authorization is re-checked inside `reportsService.datasetPage` on **every**
page, not once at the start, so a session revoked mid-export stops the stream
rather than draining it.

Presets still go through Server Actions. The exception covers streaming and
nothing else.

## Consequence

`ReadableStream.pull` is called only when the consumer is ready, so a slow
client causes no further database reads. That is what makes this genuinely
streamed rather than merely chunked.

An export is capped at 100,000 rows — not a performance limit but a guard
against an unbounded export becoming an accidental denial of service, and
against a runaway loop if a dataset query ever stopped paging correctly. The
file states plainly when it has been truncated.

---

# Final Decision

These decisions are adopted. Changing any requires a new ADR and approval from
the project owner.

---

END OF ADR-011
