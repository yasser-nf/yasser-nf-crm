import { timingSafeEqual } from "node:crypto";

import { serverEnv, isBackupStorageConfigured } from "@/config/env.server";
import { logger } from "@/lib/logger";
import { backupScheduler } from "@/modules/backups";

/**
 * The automatic-backup trigger (M07).
 *
 * Called by a scheduler, never by a person: Vercel Cron sends
 * `Authorization: Bearer <CRON_SECRET>`, and so can any external scheduler.
 * The route is outside the login redirect (UNAUTHENTICATED_ENDPOINTS) and
 * guards itself instead:
 *
 *   no CRON_SECRET configured   503 — automatic backups are off; nothing runs
 *   wrong or missing bearer     401 — compared in constant time
 *   correct bearer              one scheduler tick: a backup if one is due
 *
 * Idempotent by design (schedule.ts): calling it more often than the schedule
 * never produces more backups than the schedule. The response names what
 * happened and never carries data, errors' details or configuration.
 */

export const dynamic = "force-dynamic";

/* A backup of this CRM takes seconds; this bounds a stuck one. */
export const maxDuration = 60;

function authorised(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(header ?? "", "utf8");

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: Request): Promise<Response> {
  const secret = serverEnv.CRON_SECRET;

  if (!secret || !isBackupStorageConfigured()) {
    return Response.json({ ran: false, reason: "scheduler_not_configured" }, { status: 503 });
  }

  if (!authorised(request.headers.get("authorization"), secret)) {
    return Response.json({ ran: false, reason: "unauthorized" }, { status: 401 });
  }

  const outcome = await backupScheduler.tick(new Date());

  if (!outcome.ok) {
    logger.error("Scheduled backup tick failed", outcome.error);
    return Response.json({ ran: false, reason: "error" }, { status: 500 });
  }

  return Response.json(outcome.value, { status: outcome.value.reason === "failed" ? 500 : 200 });
}
