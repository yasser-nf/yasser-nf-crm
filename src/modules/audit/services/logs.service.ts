import "server-only";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import type { Page } from "@/lib/database";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { auditRepository } from "../repositories/audit.repository";
import {
  LOGS_PAGE_SIZE,
  buildLogsSearch,
  referencedUserIds,
  toLogEntry,
  utcDayRange,
  type LogEntry,
  type LogsFilterInput,
} from "./log-view";

/**
 * The Logs page (M06): the audit trail, read through one door.
 *
 * WHO. `view_logs`, which only Super Admins hold — the permission the
 * navigation already required, the Reports audit summaries already require,
 * and the rule 0002's RLS policy already states ("Workers may not read" audit
 * logs). Checked here, before any query, so a Worker reaching the URL or the
 * service by any route gets a refusal, not an empty page.
 *
 * WHAT. Never a row. The repository returns rows with their snapshots; this
 * service turns each into a `LogEntry` (log-view.ts) before anything leaves the
 * server, so the raw jsonb — and whatever an old row might still hold — is
 * never serialised to a browser.
 *
 * FAILURE. A failed read is returned as a failure. The page shows an error; it
 * never shows "no entries" for a query that did not run.
 */

async function list(
  filter: LogsFilterInput,
  actor: AppUser | null,
): Promise<Result<Page<LogEntry>>> {
  if (!actor) {
    return fail(new UnauthorizedError("No signed-in user to read the logs"));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.VIEW_LOGS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not view logs`, {
        userMessage: "The audit log is restricted to Super Admins.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  const { start, end } = utcDayRange(filter.from, filter.to);

  if (start && end && start.getTime() >= end.getTime()) {
    return fail(
      new ValidationError("Logs date range is inverted", {
        userMessage: "The start date is after the end date.",
      }),
    );
  }

  const page = await auditRepository.listForLogs({
    userId: filter.userId,
    entity: filter.entity,
    action: filter.action,
    start,
    end,
    search: buildLogsSearch(filter.search),
    limit: LOGS_PAGE_SIZE,
    offset: filter.offset,
  });

  if (!page.ok) {
    return page;
  }

  /*
   * Changes name people by id (assignedTo, createdBy…). Their names come from
   * ONE query for the whole page. If it fails the ids are shown instead — the
   * entries are still correct, only less friendly — rather than failing a page
   * that did load.
   */
  const names = await auditRepository.userNames(referencedUserIds(page.value.items));

  const entries = page.value.items.map((row) =>
    toLogEntry(row, names.ok ? names.value : new Map()),
  );

  return ok({ ...page.value, items: entries });
}

export const logsService = { list } as const;
