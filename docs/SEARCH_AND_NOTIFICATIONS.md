# Global Search and Notifications (M05)

## 1. Audit before implementation

| Area | Found after M02–M04 |
| ---- | ------------------- |
| Global search | Placeholder. The top-bar button and Ctrl+K only showed a "later milestone" toast. No search service, repository or action existed. |
| Notifications | Placeholder. The bell only showed a toast. No table (ADR-005 Decision 1 deferred it), no service. |
| Schema | No `notifications` table. `settings.values.notifications` holds six **email** switches, all marked `pending` and read by `configurationService.shouldNotify` (email AND type). Nothing called it. |
| Reusable | `PERMISSIONS.SEARCH` (both roles hold it); Phone Engine `normalizeIdentifier` / `formatPhoneForDisplay`; `accountEffectiveStatus`, `accountCanAllocate`, `profileCellState`; `problemsService.accountsWithActiveProblems`; problem, profile and account badge maps; the Server Action envelope pattern; the audit `recordOrWarn` contract. |
| Per-page search | Accounts, Customers, Problems and Users pages each have their own `search` filter. Customers matches PINs; none of them is global. |
| Migration | **Required** — one additive table, `0014_notifications`. |

## 2. Global search

### Where

The top bar (and Ctrl/⌘ K anywhere) opens a dialog: `src/modules/search/components/global-search.tsx`.
The authenticated layout composes it into the shell, because the module barrels are server code a
client file in `src/shared` may not import.

### What is searched

| Group | Matches | Shows | Opens | Permission |
| ----- | ------- | ----- | ----- | ---------- |
| Accounts | email (contains), id (from a full first uuid group) | email, **effective** status badge | `/accounts/:id` | `view_accounts` |
| Profiles | profile name | name, "Profile N · account email", `profileCellState` badge | the account page | `view_accounts` |
| Customers | name, phone as typed, `phone_normalized` via Phone Engine keys | name, formatted phone, Blocked | `/customers/:id` | `view_customers` |
| Problems | account email, problem type by label ("payment", "password"), id | type, account email, status | `/problems/:id` | `view_problems` |
| Users | name, email | name, email · role, non-active status | `/users/:id` | `manage_users` (Super Admin) |

Live rows only (`deleted_at is null`); problems only on live accounts, as the M04 dashboard counts
them.

**Never matched, never selected:** `password_encrypted`, `profiles.pin`, any `notes` column,
problem descriptions and resolution notes. Each query names its columns, so these values are never
even in memory. Searching by PIN stays on the Customers page, where it already was; a global box
that answered "which profile has PIN 4821" would itself be the disclosure.

### Matching

- Case-insensitive contains (`ilike '%q%'`), with LIKE's `%`, `_` and `\` escaped — `%%` matches
  nothing rather than everything.
- Prefix matches rank first within a group.
- Phone fragments go through `identifierSearchKeys` in the Phone Engine, which strips the same
  prefixes `normalizeIdentifier` strips from a whole number: `0663 94` → `66394`,
  `+213 663` → `663`, `00974 7160` → `9747160`, `@RAH` → `@rah`. No second phone format exists.
  Only phone-shaped input (digits, a leading `+`, spaces, `().-/`) yields phone keys: digits
  inside other text (`user123@icloud.com`, `kids 2024`) are not a number and match no customer's
  phone.

### Limits

- Minimum **2** characters (after trimming). Below that the server is not asked and the box says so.
- Maximum 100 characters.
- **5** hits per group; one extra row is fetched to know "more exist". When there are more, the
  group links to its own list page with `?search=` (Accounts, Customers, Problems, Users). Profiles
  have no list page, so no link. The list pages use their own filters — for example Accounts hides
  blocked accounts (M03) — so "View all" can show a different set.

### Authorization

Per group, on the server, before any query runs: a group the caller may not see is never queried
and never appears — not even empty. A Worker gets Accounts, Profiles, Customers and Problems; never
Users. The whole search requires `search`.

### States

| State | Shown |
| ----- | ----- |
| Idle (< 2 chars) | "Type at least two characters to search." |
| Loading | Skeleton rows, while typing (250 ms debounce) and while waiting |
| Results | Groups with headings, badges; arrow keys + Enter, click, Esc |
| No results | "No results for "q"." — only when every group answered |
| Group error | "Could not search customers." in place; other groups still show |
| Error | All groups failed, or the action failed: an alert with Try again. Never "no results" |

If the blocking-problem lookup fails, Accounts and Profiles report an error rather than a badge that
might call a blocked account Healthy.

### Client cache

Answers are cached in the browser for 30 s, keyed by the signed-in user as well as the text. The
query client outlives a session that ends without the Sign out button (expiry, sign-out in another
tab), so a key without the user could show one person's answer — with its Users group — to the next
person signed in on that tab. Notifications are keyed the same way.

### Performance

Four or five bounded queries in parallel, one extra grouped query for blocking problems — no N+1,
no table sent to the browser. Answers are cached by query text for 30 s. Contains-matching cannot
use a b-tree index; at this business's size (hundreds of rows per table) each scan is sub-
millisecond. **Future concern:** past roughly 50,000 profiles or customers, add `pg_trgm` GIN
indexes on `accounts.email`, `profiles.profile_name`, `customers.name` and
`customers.phone_normalized` — a migration of its own, with its write cost measured.

## 3. Notifications

### Model — `notifications` (migration 0014)

One row = one message to one person. `recipient_id`, `actor_id`, `type`, `title`, `body`,
`entity_type`/`entity_id`, `dedupe_key`, `read_at`, `created_at`. See `DATABASE_STRUCTURE.md`.

Content is a **snapshot** (problem type, account email, who acted). It never includes the problem
description or resolution note: those are free text, and a password pasted into one must not be
copied into another person's notifications, where no redaction would reach it.

### Events

All four are existing Problems transitions (M08). Notifications are written by the Problems
services after the write and the audit entry succeed — bulk actions reach the same single-problem
services, so they notify identically.

| Event | Recipients | Dedupe key |
| ----- | ---------- | ---------- |
| `problem_reported` | every active Super Admin | `problem_reported:<id>` |
| `problem_assigned` | the new assignee | `problem_assigned:<id>:<updated_at>` |
| `problem_resolved` | the reporter and the assignee | `problem_resolved:<id>:<resolved_at>` |
| `problem_reopened` | the assignee, else every active Super Admin | `problem_reopened:<id>:<reopen_count>` |

Never the person who acted; never a suspended, disabled or archived user (chosen inside the insert).
A deleted problem's notifications are removed with it.

A notification failure never fails the operation (`notifyOrWarn`, same contract as the audit
trail). There is no action that creates a notification: only services do.

### Duplicate prevention

`unique (recipient_id, dedupe_key)` + `on conflict do nothing`. A retried call, or two paths
reporting one event, produces one notification per person. A genuinely new event (reassigned
later, reopened again) has a new key.

### Reading

- Bell with the exact unread count (`99+` above 99), from a partial index.
- Panel: the 20 most recent; unread ones are marked; clicking marks read and opens the linked page.
- Mark all as read.
- Links come from a closed map (`issue` → `/problems/:id`); a row cannot link anywhere else.

Every read and mark is scoped to the signed-in person **in the query**. Another person's
notification is "not found" — never read, never marked.

### Freshness — no polling

Fetched on mount, when the panel opens, and after navigation if older than 30 s. Nothing polls
(nothing in the application did before M05). A notification created while someone sits on one page
appears when they move or open the panel.

### Error states

A failed count shows a warning mark on the bell, never "0". A failed list says "could not be
loaded", never "You have no notifications".

### Retention

None. Rows accumulate (one per recipient per event). At this volume that is negligible; when it is
not, a retention job belongs with the backup/jobs work, not here.

## 4. Settings

The existing `notifications.*` settings describe **email** delivery (`shouldNotify` requires
`email` AND the type) and remain `pending`. In-app notifications are always on. Whether the per-type
switches should also silence in-app notices is a product decision and was not taken here.
