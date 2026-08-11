import { config } from "dotenv";
import postgres from "postgres";

/**
 * Reports how many pooler clients are currently in use.
 *
 * M12 found the session pooler's 15-client cap to be the project's tightest
 * production constraint. This is the fastest way to see whether it is saturated
 * before blaming a test failure on the code.
 */

config({ path: ".env.local", quiet: true });

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, connect_timeout: 5 });

try {
  const rows = await sql`
    select
      count(*)::int as total,
      count(*) filter (where state = 'active')::int as active,
      count(*) filter (where state = 'idle')::int as idle,
      count(*) filter (where application_name like '%postgres%')::int as app_clients
    from pg_stat_activity
    where datname = current_database()
  `;

  console.log(JSON.stringify(rows[0]));
} catch (error) {
  console.log(`UNREACHABLE: ${error.message.slice(0, 90)}`);
} finally {
  await sql.end({ timeout: 3 });
}
