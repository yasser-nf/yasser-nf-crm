# Reports Module

Version: 1.0
Milestone: M10

Authority: `.ai/` decides, this describes. Decisions in ADR-011.

---

## 1. Responsibilities

| Owns | Does not own |
| ---- | ------------ |
| The report catalogue and its RBAC | Any business data |
| Aggregate SQL per report | The health rule — reused from M09 |
| CSV, Excel and print serialisation | Allocation, presence, problem state |
| Saved presets (its one table) | The audit log |

The module computes no business rules. The System Health report reuses
`assessHealth` from M09 rather than restating it, so the report and the
dashboard light can never disagree about what "red" means.

---

## 2. Architecture

```
app/(app)/reports/                    catalogue + one report per key
app/api/reports/export/route.ts       the streaming exception (ADR-011 D3)
  └── modules/reports (barrel)
        ├── components/               catalogue card grid, report view
        ├── actions/                  presets only
        ├── services/
        │     ├── report-definitions.ts  the catalogue     (pure, testable)
        │     ├── reports.service.ts     RBAC + assembly
        │     ├── export.service.ts      streaming orchestration
        │     ├── csv.service.ts         RFC 4180          (pure, testable)
        │     ├── excel.service.ts       SpreadsheetML     (pure, testable)
        │     └── pdf.service.ts         printable HTML    (pure, testable)
        ├── repositories/
        │     ├── reports.repository.ts  aggregate + dataset SQL
        │     └── presets.repository.ts
        └── validation/
```

Repositories are **not** exported. Between them they can read every business
table in the system, and exposing either would offer a route past the
per-report permission check.

The serialisers **are** exported. They are pure functions over rows and columns
with no data access at all.

---

## 3. The Report Engine

Every report is two SQL statements:

| | Purpose |
| - | ------- |
| **summary** | One aggregate row — the headline figures |
| **dataset** | The rows an export contains, paged |

Both are filtered identically, which is what makes "export only filtered
results" true by construction: the export URL is built from the same query
string the screen is showing.

Paging is applied *around* each report's query rather than inside it, so every
report pages the same way and a new report cannot forget to.

The ten reports: accounts · profiles · customers · problems · users · backups ·
quick-prepare · system-health · audit-summary · activity-summary.

### Adding a report

1. Add a key to `REPORT_KEYS` and a definition (title, permission, filters, columns).
2. Add a `datasetQuery` case and a `summaryQuery` case.

Nothing else changes. The catalogue, RBAC, filters, search, paging, all three
export formats and the print view come from the definition.

---

## 4. Export Flow

```
Report view  →  /api/reports/export?report=…&format=…&<same filters>
                     │
                     ├─ resolve caller · 401 if absent
                     ├─ validate report key and format · 400
                     ├─ permission check · 403
                     ▼
                exportService.build
                     │
      header  →  pull page (500 rows)  →  serialise  →  pull again  →  footer
                     │
                     └─ permission re-checked on EVERY page
```

`ReadableStream.pull` is called only when the consumer is ready, so a slow
client causes no further database reads. The uncompressed result never exists in
memory as a whole.

| Format | MIME | Notes |
| ------ | ---- | ----- |
| CSV | `text/csv` | UTF-8 BOM so Excel on Windows reads accents correctly |
| Excel | `application/vnd.ms-excel` | SpreadsheetML 2003; numbers stay numbers |
| PDF | `text/html` served **inline** | Browser print-to-PDF; the document prints itself on load |

PDF is the exception to streaming: a printable document's layout depends on the
whole table, so it is assembled in full and bounded to 2,000 rows. Nobody prints
a hundred thousand rows, and pretending otherwise would produce a document no
browser could paginate.

Tabular exports are capped at **100,000 rows** and say so in the file when
truncated — a guard against an unbounded export, not a performance limit.

### CSV injection

A field beginning `=`, `+`, `-` or `@` is prefixed with a tab. A customer named
`=cmd|...` would otherwise become executable the moment somebody opens the
export in Excel. The text still displays correctly.

---

## 5. Permissions

Declarative. Each report names the permission it needs, and that single field is
the whole of report RBAC — there is no second list of "reports a Worker may
see", because a second list is a list that disagrees.

| Report | Permission | Worker |
| ------ | ---------- | ------ |
| Accounts, Profiles | `VIEW_ACCOUNTS` | yes |
| Customers | `VIEW_CUSTOMERS` | yes |
| Problems | `VIEW_PROBLEMS` | yes |
| Quick Prepare | `PREPARE_SUBSCRIPTIONS` | yes |
| Users | `MANAGE_USERS` | **no** |
| Backups | `ACCESS_BACKUPS` | **no** |
| System health | `VIEW_SYSTEM_INFORMATION` | **no** |
| Audit summary, Activity summary | `VIEW_LOGS` | **no** |

The catalogue is filtered by the same function, so a Worker is never shown a
card that would then refuse them.

Presets are owned. The service filters by owner and the RLS policy enforces
`user_id = auth.uid()` independently — even a Super Admin cannot read another
person's saved views through the API.

---

## 6. Performance

| Concern | Approach |
| ------- | -------- |
| Aggregates | Computed in SQL with `filter (where …)`. Counting rows in JavaScript would be N+1, and an average over a paged subset would simply be wrong |
| Report page | Summary, rows and count run in `Promise.all` |
| Export | Paged at 500 rows, backpressure-aware |
| Row counts | `count(*)` over the report's own query, so filters apply identically |
| Caching | **None.** A report reflects the database at the moment it ran; a cached one hands somebody yesterday's figures with today's timestamp. `Cache-Control: no-store` on the export |

---

## 7. Extension Points

| Want to | Do |
| ------- | -- |
| Add a report | Two additions — a definition and its two queries |
| Add a filter | Add the key to `FilterKey`, the schema, and the report's `where` |
| Add an export format | Contribute a header, a row serialiser and a footer |
| Add revenue | The Orders table is deferred (ADR-005 D1); a revenue report slots in as an eleventh definition |
| Server-side PDF | Would need a renderer and a new ADR amending ADR-011 Decision 1 |

---

## 8. Database

One table, `report_presets`. The justification the brief asked for is in ADR-011
Decision 2: presets are per-user rows that accumulate, and `settings` is a
singleton whose single JSON blob would have no ownership and would clobber under
concurrent saves.

No other schema was added. Every report reads tables that already existed.

---

## 9. Tests

| File | Covers |
| ---- | ------ |
| `tests/unit/report-export.test.ts` | 37 cases — CSV quoting and injection, XML escaping and cell typing, print layout, catalogue RBAC, filter validation |
| `tests/integration/reports-module.test.ts` | 30 cases — **all ten reports executed live**, filters, search, paging, RBAC refusals, preset ownership, streaming |

Running every report against the live schema is the point of the integration
suite: each is hand-written aggregate SQL that TypeScript cannot check, so a
wrong column name only surfaces when the query runs.

---

## 10. Known Gaps

| Gap | Consequence |
| --- | ----------- |
| No authenticated-browser verification | Screens and the download flow have never been exercised by a real session |
| Excel is `.xls` SpreadsheetML, not `.xlsx` | Opens everywhere; may warn about the extension on some configurations |
| PDF needs one click | No server-side PDF, so a report cannot be emailed on a schedule |
| Charts are not on the report screens | The M10 brief lists them; the summary strip carries the figures, and the dashboard already renders the trend charts. Reported as not delivered |
| Column selection is not editable | Presets store `columns`, but the view always renders the definition's full set |
| Heatmaps | Not built — no report has two dimensions dense enough to justify one |

---

## 11. Running The Tests

**Stop the dev server first.** Supabase's session pooler caps this project at 15
clients and the Next dev server holds a pool of up to 10. With it running the
integration suite starves for connections — the same tests that finish in twelve
seconds took nearly eight hours and reported five failures unrelated to the
code. The symptom points squarely at the wrong thing, which is why it is written
down here and in `vitest.config.ts`.
