import { config } from "dotenv";
import postgres from "postgres";

/**
 * Removes throwaway accounts left behind by an interrupted integration run.
 *
 * The M08 suite creates an account named `m08-test-*@example.invalid` and drops
 * it in `afterAll`. If the run dies before that — a connection-pool exhaustion,
 * for instance — the row survives and would otherwise linger in real data.
 *
 * Matches only the reserved `.invalid` test domain, so it can never touch a
 * genuine account.
 */

config({ path: ".env.local", quiet: true });

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

const removed = await sql`
  delete from public.accounts
  where email like 'm08-test-%@example.invalid'
  returning id, email
`;

console.log(`Removed ${removed.length} leftover test account(s).`);

for (const row of removed) {
  console.log(`  ${row.email}`);
}

await sql.end();
