import { config } from "dotenv";
import postgres from "postgres";

/** Read-only snapshot of what M08 left in the database. */

config({ path: ".env.local", quiet: true });

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

const counts = await sql`
  select
    (select count(*)::int from public.issues) as issues,
    (select count(*)::int from public.issue_notes) as notes,
    (select count(*)::int from public.audit_logs where entity = 'issue') as issue_audit_rows,
    (select count(*)::int from public.accounts where email like '%@example.invalid') as leftover_test_accounts,
    (select count(*)::int from public.accounts) as accounts
`;

const policies = await sql`
  select tablename, policyname from pg_policies
  where schemaname = 'public' and tablename in ('issues', 'issue_notes')
  order by tablename, policyname
`;

const indexes = await sql`
  select indexname from pg_indexes
  where schemaname = 'public' and tablename = 'issues'
  order by indexname
`;

console.log(JSON.stringify({ counts: counts[0], policies, indexes }, null, 2));

await sql.end();
