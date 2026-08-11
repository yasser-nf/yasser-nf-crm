import { config } from "dotenv";
import postgres from "postgres";

/**
 * Production readiness audit — database half.
 *
 * Read-only. Every check reports a fact measured from the live database rather
 * than a claim about it, which is the whole point: M12 asks whether the system
 * is production-grade, and that cannot be answered from the source tree.
 */

config({ path: ".env.local", quiet: true });

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

const report = {};

/* ---- RLS and grant coverage ------------------------------------------- */

report.rls = await sql`
  select c.relname as table_name, c.relrowsecurity as rls_enabled,
         (select count(*)::int from pg_policies p
          where p.schemaname = 'public' and p.tablename = c.relname) as policies
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
  order by c.relname
`;

/* Anything anon or authenticated can still touch directly. */
report.grants = await sql`
  select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')
  group by table_name, grantee
  order by table_name, grantee
`;

/* ---- Foreign key coverage --------------------------------------------- */

/*
 * An unindexed foreign key makes every parent delete scan the child table and
 * holds locks for the duration. Postgres does not create these automatically.
 */
report.unindexedForeignKeys = await sql`
  select c.conrelid::regclass::text as table_name, a.attname as column_name
  from pg_constraint c
  join lateral unnest(c.conkey) as k(attnum) on true
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.contype = 'f'
    and c.connamespace = 'public'::regnamespace
    and not exists (
      select 1 from pg_index i
      where i.indrelid = c.conrelid
        and a.attnum = any(i.indkey::smallint[])
        and i.indkey[0] = a.attnum
    )
  order by 1, 2
`;

/* ---- Index usage ------------------------------------------------------- */

report.indexUsage = await sql`
  select relname as table_name, indexrelname as index_name, idx_scan as scans
  from pg_stat_user_indexes
  where schemaname = 'public'
  order by idx_scan asc, relname
`;

report.tableScans = await sql`
  select relname as table_name, seq_scan, idx_scan, n_live_tup as live_rows,
         last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
  from pg_stat_user_tables
  where schemaname = 'public'
  order by seq_scan desc
`;

/* ---- Constraint coverage ----------------------------------------------- */

report.constraints = await sql`
  select conrelid::regclass::text as table_name,
         count(*) filter (where contype = 'c')::int as checks,
         count(*) filter (where contype = 'f')::int as foreign_keys,
         count(*) filter (where contype = 'u')::int as uniques,
         count(*) filter (where contype = 'p')::int as primary_keys
  from pg_constraint
  where connamespace = 'public'::regnamespace
  group by conrelid
  order by 1
`;

/* ---- Migration state ---------------------------------------------------- */

report.migrations = await sql`
  select count(*)::int as applied,
         to_char(to_timestamp(max(created_at) / 1000), 'YYYY-MM-DD HH24:MI') as latest
  from drizzle.__drizzle_migrations
`;

/* ---- Connections and long transactions ---------------------------------- */

report.connections = await sql`
  select count(*)::int as total,
         count(*) filter (where state = 'active')::int as active,
         count(*) filter (where state = 'idle in transaction')::int as idle_in_transaction,
         max(extract(epoch from (now() - xact_start)))::int as longest_txn_seconds
  from pg_stat_activity
  where datname = current_database()
`;

report.blocking = await sql`
  select count(*)::int as blocked
  from pg_locks l
  where not l.granted
`;

/* ---- Table sizes -------------------------------------------------------- */

/* Every column qualified: pg_class and pg_stat_user_tables both expose relname. */
report.sizes = await sql`
  select c.relname as table_name,
         pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
         coalesce(s.n_live_tup, 0) as live_rows,
         coalesce(s.n_dead_tup, 0) as dead_rows
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_stat_user_tables s on s.relid = c.oid
  where n.nspname = 'public' and c.relkind = 'r'
  order by pg_total_relation_size(c.oid) desc
`;

console.log(JSON.stringify(report, null, 2));

await sql.end();
