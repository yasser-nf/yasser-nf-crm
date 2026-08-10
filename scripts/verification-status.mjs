import { config } from "dotenv";
import postgres from "postgres";

/**
 * Read-only snapshot of the tables M06 and M07 touch.
 *
 * Verification tooling: it reports state so runtime claims can be checked
 * against the database rather than against a service's return value. It writes
 * nothing.
 */

config({ path: ".env.local", quiet: true });

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

const users = await sql`
  select id, name, email, role, status, deleted_at, last_login_at
  from public.users order by created_at
`;

const backups = await sql`
  select id, name, type, status, size_bytes, format_version, app_version,
         is_restore_point, table_counts, left(checksum, 12) as checksum_head,
         created_at, verified_at, error_message
  from public.backups order by created_at desc limit 10
`;

const audit = await sql`
  select entity, action, entity_id, created_at from public.audit_logs
  order by created_at desc limit 6
`;

console.log(JSON.stringify({ users, backups, audit }, null, 2));

await sql.end();
