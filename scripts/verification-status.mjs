import { config } from "dotenv";
import postgres from "postgres";

/**
 * Read-only snapshot of the tables M06 touches.
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

const sessions = await sql`
  select id, user_id, created_at, updated_at from auth.sessions order by updated_at desc
`;

const audit = await sql`
  select entity, action, entity_id, created_at from public.audit_logs
  order by created_at desc limit 8
`;

const history = await sql`
  select event_type, email, failure_reason, ip_address, created_at
  from public.login_history order by created_at desc limit 10
`;

console.log(JSON.stringify({ users, sessions, audit, history }, null, 2));

await sql.end();
