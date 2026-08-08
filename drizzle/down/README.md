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
