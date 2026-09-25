# Logs and Audit (M06)

## 1. Audit before implementation

| Area | Found |
| ---- | ----- |
| `/logs` | Missing. `ROUTES.LOGS` and a sidebar entry (gated on `view_logs`) existed; no page did. |
| `audit_logs` | Immutable table (no update/delete columns or repository methods), `entity` × 7, `action` × 7, jsonb `before`/`after`, `user_id` (set null on delete) plus denormalised `actor_email`, `ip_address`, `user_agent`, `created_at`. Indexes on (entity, entity_id, created_at), (user_id, created_at), action, created_at. **No result/status column** — entries are written only after an operation succeeds. |
| Writing | `auditService.record` / `recordOrWarn`. Every snapshot passes `sanitizeAuditSnapshot`: per-entity allow-list, then deep redaction of sensitive keys (pin, password, token, secret, cookie, credential, api key…) at every depth, arrays included; dropped key names listed under `_omitted`. |
| Historical PINs | Redacted by migration 0013 (applied). |
| Readers | Problem timeline, user activity, account/customer history, dashboard, Reports (`audit-summary`, `activity-summary`, both `view_logs`). |
| Authorization | `view_logs` — Super Admin only (absent from the Worker allow-list). |
| RLS (0002) | RLS on; `anon`/`authenticated` hold no grants; policies `audit_logs_read_admin` (SELECT, `is_super_admin()`) and `audit_logs_insert`. Browser roles are refused before any policy runs. |
| Failed-query logging | **Confirmed live.** `AppError.toLogObject` wrote `String(cause)`; Drizzle's `DrizzleQueryError` message is `Failed query: … params: <values>`. `toAppError` also copied that message into a new error. A failed PIN update logged the PIN; a failed audit insert logged the whole snapshot. Seen in production output during M05 verification. |
| Migration needed | **No.** Existing indexes cover every filter. |

## 2. The Logs page

`/logs`, Super Admin only, enforced in `logsService` before any query (Workers get a refusal, the
signed-out an unauthorized error; the proxy and layout also redirect the signed-out).

- **Columns:** time (UTC), person (current name, email; `actor_email` when the user is gone,
  "System" when neither), action, entity (+ subject: account email, user name, customer name,
  profile name), summary.
- **Filters (server-side):** person, entity, action, from/to (UTC days, inclusive), search. No
  result filter: the schema has no failure records.
- **Search:** actor name/email, subject email, entity id (from its first 8 hex characters), action,
  entity and event names by label. Wildcards escaped (`utils/like.ts`, shared with M05). Never
  searches notes, descriptions, phone numbers or any other snapshot content.
- **Pagination:** 25 per page, Previous/Next, `created_at desc, id desc` (stable across pages).
- **Detail:** a dialog built from the same entry — changes (field, before, after), details (event
  metadata), source (IP, browser). No second request.
- **States:** skeleton while loading; "Not available to your role"; error ("Could not load the
  audit log") — never "0 entries"; "No audit entries yet"; "No entries match these filters" with
  Clear; "No entries on this page" past the end.

## 3. What an entry may show (`log-view.ts`)

The server turns each row into a `LogEntry`; raw `before`/`after` never leave the server.

1. Sensitive keys are hidden again on read with the write-time rule (`isSensitiveKey`), at every
   depth — so rows written before any rule existed are still safe.
2. Values shaped like account ciphertext (`v1:iv:tag:data`) are hidden under any key.
3. Free text — `notes`, `description`, `resolutionNote`, `reason`, `errorMessage` — shows as
   "Text hidden (N characters)". Operators type into those, and a pasted password would otherwise
   be shown to every reader of the log.
4. Objects are never dumped; arrays of plain values are listed, anything deeper summarised.
5. Links come from a closed map (account, customer, problem, user, backup, settings; a profile
   links to its account). A deleted entity has no link.

Stored names are never rewritten: actions, entities and events are mapped to labels on read;
unknown events are humanised from their stored name.

## 4. Failed-query parameter logging — fixed

`src/lib/errors/log-safe.ts`:

- `describeCause` reads only `name`, `code` and `message` along the cause chain (depth 4, cycles
  cut); it never spreads or stringifies an unknown object, so `params`/`parameters` cannot ride
  along.
- `scrubErrorText` replaces Drizzle's `params: …` tail with `params: [redacted]` and blanks values
  PostgreSQL echoes (`invalid input syntax for type integer: "[redacted]"`).
- Applied in `AppError.toLogObject` (message and cause), `toAppError`, and `logger.error` for
  non-AppError values.

Kept: error names, SQLSTATE, the parameterised SQL text, the database's message, the operation
name. Regression tests use a real `DrizzleQueryError` and a real failing query against the isolated
database.

## 5. Audit failure semantics

Best-effort, unchanged. `recordOrWarn` — used by every producer — never fails a business operation
that already succeeded; a failed write is logged (now without its snapshot values). `record` remains
for a caller that must not proceed without its entry; none does today.

## 6. Event completeness

Reviewed: account create / bulk create / update / password change / password reveal (single and
bulk) / archive / restore / delete / bulk notes; profile update and sale unassign; Quick Prepare
allocation and password-change confirmation; Quick Replace; problem report / update / assign /
resolve / reopen / close / cancel / delete (bulk actions go through the same services); user create
/ update (role, status) / archive / invitation resend; session revoke (one, all); backup create /
delete / restore; settings update; customer notes / block / archive.

**Gap fixed:** customer creation. `customersService.findOrCreateByPhone` — used by Quick Prepare
and by assigning a customer to a profile — created customers with no audit entry. It now accepts
the caller's audit context and records `customer / create`.

## 7. Deferred

- **Self-service password change** is done in the browser directly against Supabase Auth; recording
  it needs a new server path. Sign-ins and sign-outs are in `login_history`, not `audit_logs`.
- **Database-level immutability** (REVOKE UPDATE/DELETE from the application role) remains
  outstanding, as recorded in the schema.
- **Search on jsonb fields** (`after->>'email'`, `after->>'event'`) is unindexed; fine at thousands
  of rows, worth an expression index at hundreds of thousands.
- **Retention**: none, by design (the log is immutable).
