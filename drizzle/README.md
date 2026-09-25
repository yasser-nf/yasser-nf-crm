# Migrations

## State after M01.5

- `0000`–`0013` are the migration history. `drizzle/meta/_journal.json` lists all of them.
- `meta/0012_snapshot.json` is a **baseline**, generated from the TypeScript schema in M01.5.
  Snapshots `0007`–`0011` do not exist and are not needed: `drizzle-kit generate` diffs only
  against the latest snapshot.
- `meta/0013_snapshot.json` equals `0012` (0013 is data-only).

Before M01.5 the latest snapshot was `0006`, so `generate` diffed today's schema against a
six-migration-old picture and stopped at interactive "created or renamed?" prompts, where a
wrong answer emits `DROP COLUMN`.

## What production has applied (verified M01.5)

`drizzle.__drizzle_migrations` records `0000`–`0011`. A catalog comparison of 299 objects
found production identical to a clean replay of `0000`–`0011`.

- **`0012_customer_identifier` is NOT applied.** Production still has
  `customers_phone_normalized_digits`, so `@username` customer identifiers are refused there.
- `0013_redact_audit_pins` is new and not applied.
- The row recorded for `0007` has a hash matching no file here: `0007_backup_module.sql` was
  edited after it was applied. Its end state matches production, so it is harmless, but
  **never edit an applied migration** — write a new one.

The migrator applies by timestamp: everything newer than the last recorded `created_at`. The
next `drizzle-kit migrate` against production therefore applies **0012 and 0013 together**.
Deploy the application code first — 0013 must run after the code stops writing PINs.

## M05: 0014_notifications

`0014_notifications` adds one table (`notifications`), its two foreign keys, four indexes and its
RLS lockdown. It is purely additive — no existing object or row is touched — and has a
hand-written `down/0014_notifications.down.sql`.

**It is NOT applied to production.** M05 was implemented locally; the migration runs only in the
isolated test database. Applying it is part of the M05 deployment, not of its implementation.

## Creating a migration

1. Change the TypeScript schema in `src/lib/drizzle/schema/`.
2. `npx drizzle-kit generate --name <what_changed>` in an interactive terminal.
   - If it asks "created or renamed?", stop and read the question. A rename answered as
     create/drop loses the column's data.
3. Read the generated SQL before anything else. It is the change; the TypeScript is not.
4. For data changes or anything drizzle cannot express, use
   `npx drizzle-kit generate --custom --name <what_changed>` and write the SQL into the empty
   file. That still writes the journal entry and a snapshot — never hand-edit either.
5. Add `down/<tag>.down.sql` (see `down/README.md`).
6. `npm run db:check`, then `npm test` — `tests/unit/migrations.test.ts` fails if the latest
   snapshot and the schema disagree, and replays every migration from nothing.
7. `npm run test:integration` runs the integration suite against an in-process PostgreSQL with
   all migrations applied. Never point it at production; the guard refuses.

Objects created only by hand-written SQL are not in the TypeScript schema and so not in the
snapshot: the `users → auth.users` foreign key (0001), five foreign-key indexes (0010) and the
orphaned `accounts.health_score` column. `generate` will neither drop nor recreate them.
Declaring one in TypeScript later makes `generate` try to create it again — write that
migration by hand with `if not exists`.
