import { config } from "dotenv";
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

/**
 * Repairs backup rows whose checksum was zeroed by an earlier test run.
 *
 * A previous version of the integration suite corrupted a real backup's recorded
 * checksum to prove restore refuses a mismatch, and never put it back. Those
 * rows are unrestorable but their stored files are intact, so the true checksum
 * is recoverable by re-hashing the object.
 *
 * One-off repair tooling. The test that caused this now restores the value in a
 * `finally` block, so this should never be needed again.
 */

config({ path: ".env.local", quiet: true });

const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const broken = await sql`
  select id, filename from public.backups
  where checksum = repeat('0', 64) and filename is not null
`;

console.log(`Found ${broken.length} backup(s) with a zeroed checksum.`);

for (const row of broken) {
  const file = await admin.storage.from("backups").download(row.filename);

  if (file.error || !file.data) {
    console.log(`  ${row.id}: artifact missing, marking failed`);
    await sql`
      update public.backups
      set status = 'failed', error_message = 'Artifact missing from storage'
      where id = ${row.id}::uuid
    `;
    continue;
  }

  const body = Buffer.from(await file.data.arrayBuffer());
  const checksum = createHash("sha256").update(body).digest("hex");

  await sql`
    update public.backups
    set checksum = ${checksum}, status = 'verified', verified_at = now(), error_message = null
    where id = ${row.id}::uuid
  `;

  console.log(`  ${row.id}: repaired -> ${checksum.slice(0, 12)}…`);
}

await sql.end();
