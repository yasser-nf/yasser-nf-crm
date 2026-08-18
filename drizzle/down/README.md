# Down Migrations

## Why these are hand-written

`drizzle-kit` does not generate down migrations and has no `rollback` command. It
tracks applied migrations in `drizzle/meta/_journal.json` and only moves forward.

The M02 brief requires migrations to be reversible. These files provide that. What
they cannot provide is automated execution, because nothing in the toolchain runs
them.

## How to apply one

Run the file against the database, newest first, then remove the corresponding
entry from `drizzle/meta/_journal.json` so `drizzle-kit` stops believing it is
applied.

Via the Supabase SQL editor, or:

```bash
psql "$DATABASE_URL" -f drizzle/down/0001_auth_users_fk.down.sql
```

**Order matters.** Roll back in reverse: `0001` before `0000`. Dropping a table
before its dependent constraint is removed will fail.

## Verifying one before you trust it

`scripts/rollback-drill.mjs` runs a migration **UP → DOWN → UP** against a
disposable schema and asserts the shape after each step:

```bash
node scripts/rollback-drill.mjs 0011_account_inventory
```

Add a table fixture to `TABLES` in that script for each migration you drill. It
builds a minimal table with only the columns the migration touches, so it proves
the migration's own SQL is reversible — not that it composes with every
constraint on the real table. For anything touching an existing constraint,
index or enum, declare the real shape or the drill will pass while production
fails.

`0011_account_inventory` passes. It is the only file here that is no longer
UNVERIFIED.

## Two traps worth knowing before writing one

Both were hit for real while building M13, not read about.

**Enum values are close to irreversible.** PostgreSQL has no
`ALTER TYPE ... DROP VALUE`, so reversing one means renaming the type, creating a
replacement, re-typing the column and dropping the old type. That rollback
failed on first execution with

```
ERROR: operator does not exist: profile_status = profile_status_old
```

because `ALTER COLUMN ... TYPE` cannot proceed while a CHECK constraint and a
partial index still bind typed literals of the old type. Both had to be dropped
before the cast and recreated after, and the failure left the database
mid-rollback needing manual repair. M13 was redesigned to add no enum value at
all — see ADR-013 Decisions 2 and 8.

**A new enum label cannot be used in the transaction that adds it.** Naming it in
a CHECK expression counts as using it, and `drizzle-kit` wraps each file in one
transaction. If a future migration adds an enum value and anything references it,
it must be split across two files, and merging them later will fail at deploy
time rather than at review time.

## Verification status

**UNVERIFIED.** These have never been executed. No Supabase project exists,
`DATABASE_URL` is a placeholder, and there is no local PostgreSQL, `psql`, or
Docker on the development machine.

The SQL is written against the exact object names in the generated up-migrations,
but "reads correctly" is not "runs correctly". Run each one against a scratch
database before ever relying on it in production.

## Keeping these in step

`drizzle-kit generate` will not write a down file for you. Every new migration
needs its counterpart added here by hand, or reversibility silently rots.
