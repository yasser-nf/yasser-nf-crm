import "server-only";

import type { AppUser } from "@/lib/auth";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AccountRow, ProfileRow } from "@/lib/drizzle/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Page, PaginationInput } from "@/lib/database";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  accountsRepository,
  type AccountFilter,
  type AccountWithCounts,
} from "../repositories/accounts.repository";
import { profilesRepository } from "../repositories/profiles.repository";
import { accountInsertSchema, accountUpdateSchema } from "../validation/account.schema";
import { PROFILES_PER_ACCOUNT } from "../validation/profile.schema";

/**
 * Accounts service.
 *
 * 02_ARCHITECTURE.md: the service decides. It owns authorization, business
 * rules and the audit trail; the repository only reads and writes.
 *
 * The rule this file exists to enforce is the one from 01_MASTER_RULES.md:
 *
 *   If an account is not Healthy, ALL of its profiles become unavailable for
 *   allocation, regardless of their own status. No exceptions.
 *
 * That is computed here and never stored. Writing an "unavailable" flag onto
 * five profiles every time an account changes status would duplicate state,
 * which 03_DATABASE.md forbids, and would go stale the moment a status change
 * failed halfway.
 */

/** A profile with the account-level rule already applied. */
export interface ProfileAllocation {
  readonly profile: ProfileRow;
  /**
   * Whether this profile may be allocated right now.
   *
   * Never read `profile.status === "available"` on its own. That answer ignores
   * the account, and is the single easiest way to sell a profile on a broken
   * account.
   */
  readonly isAllocatable: boolean;
  /** Why not, when it is not. Null when allocatable. */
  readonly blockedReason: "account_not_healthy" | "profile_not_available" | null;
}

export interface AccountDetail {
  readonly account: AccountRow;
  readonly profiles: readonly ProfileAllocation[];
  /** False when the account's own status blocks every profile. */
  readonly accountAllowsAllocation: boolean;
  /** True when the profile count is not exactly five. Signals corrupt data. */
  readonly hasProfileCountAnomaly: boolean;
}

/**
 * Applies the unhealthy-account rule.
 *
 * Exported so the Smart Stock Engine and Quick Prepare use the same function
 * rather than reimplementing the rule. One definition, one place to be wrong.
 */
export function evaluateAllocation(account: AccountRow, profile: ProfileRow): ProfileAllocation {
  if (account.status !== "healthy") {
    return { profile, isAllocatable: false, blockedReason: "account_not_healthy" };
  }

  if (profile.status !== "available") {
    return { profile, isAllocatable: false, blockedReason: "profile_not_available" };
  }

  return { profile, isAllocatable: true, blockedReason: null };
}

/**
 * Only a Super Admin may delete an account.
 *
 * 01_MASTER_RULES.md lists deleting accounts among the things a Worker cannot
 * do. Enforced here, in the service, rather than by hiding a button — the UI is
 * a suggestion, and a Server Action is a POST endpoint anyone holding a session
 * can call directly.
 *
 * The role is read from public.users by getCurrentUser, which ADR-005 Decision 3
 * made authoritative. It is never read from Supabase Auth metadata: a second
 * copy of an authorization decision is a copy that can disagree with the real
 * one.
 */
function assertMayDelete(actor: AppUser | null): Result<AppUser> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user for a delete operation"));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.DELETE_ACCOUNTS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not delete accounts`, {
        userMessage: "You do not have permission to delete accounts. Archive it instead.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  return ok(actor);
}

async function listAccounts(filter: AccountFilter): Promise<Result<Page<AccountWithCounts>>> {
  return accountsRepository.listWithCounts(filter);
}

/**
 * Reads an account with its profiles and the allocation rule applied.
 */
async function getAccountDetail(id: string): Promise<Result<AccountDetail>> {
  const accountResult = await accountsRepository.findById(id);

  if (!accountResult.ok) {
    return accountResult;
  }

  const profilesResult = await profilesRepository.listByAccount(id);

  if (!profilesResult.ok) {
    return profilesResult;
  }

  const account = accountResult.value;

  return ok({
    account,
    profiles: profilesResult.value.map((profile) => evaluateAllocation(account, profile)),
    accountAllowsAllocation: account.status === "healthy",
    /*
     * Surfaced rather than thrown. A count other than five means data arrived
     * outside accountsRepository.create — a migration or a manual insert. The
     * page should say so instead of silently rendering four cards.
     */
    hasProfileCountAnomaly: profilesResult.value.length !== PROFILES_PER_ACCOUNT,
  });
}

/**
 * Creates an account and its five profiles.
 *
 * The repository performs the write in one transaction; this method adds
 * validation and the audit entry.
 */
async function createAccount(input: unknown, context: AuditContext): Promise<Result<AccountRow>> {
  const parsed = accountInsertSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues, "Account input failed validation"));
  }

  const created = await accountsRepository.create(parsed.data, context.actor?.id ?? null);

  if (!created.ok) {
    return created;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: created.value.id,
      action: "create",
      after: created.value,
    },
    context,
  );

  return created;
}

/**
 * Updates an account.
 *
 * Reads the previous row first so the audit entry can carry a real before/after
 * pair. The audit service strips the password from both.
 */
async function updateAccount(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<AccountRow>> {
  const parsed = accountUpdateSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues, "Account update failed validation"));
  }

  const before = await accountsRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const updated = await accountsRepository.update(id, parsed.data);

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: id,
      action: "update",
      before: before.value,
      after: updated.value,
    },
    context,
  );

  return updated;
}

async function archiveAccount(id: string, context: AuditContext): Promise<Result<AccountRow>> {
  const before = await accountsRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const archived = await accountsRepository.archive(id);

  if (!archived.ok) {
    return archived;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: id,
      action: "archive",
      before: before.value,
      after: archived.value,
    },
    context,
  );

  return archived;
}

async function restoreAccount(id: string, context: AuditContext): Promise<Result<AccountRow>> {
  const before = await accountsRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  if (before.value.status !== "archived") {
    return fail(
      new ValidationError("Only an archived account can be restored", {
        userMessage: "This account is not archived, so there is nothing to restore.",
      }),
    );
  }

  const restored = await accountsRepository.restore(id);

  if (!restored.ok) {
    return restored;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: id,
      action: "restore",
      before: before.value,
      after: restored.value,
    },
    context,
  );

  return restored;
}

/**
 * Soft delete.
 *
 * 01_MASTER_RULES.md: records are never permanently deleted. This sets a
 * tombstone; nothing in the codebase issues a DELETE against accounts.
 */
async function softDeleteAccount(id: string, context: AuditContext): Promise<Result<AccountRow>> {
  const permitted = assertMayDelete(context.actor);

  if (!permitted.ok) {
    return permitted;
  }

  const before = await accountsRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const deleted = await accountsRepository.softDelete(id);

  if (!deleted.ok) {
    return deleted;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: id,
      action: "delete",
      before: before.value,
      after: deleted.value,
    },
    context,
  );

  return deleted;
}

/**
 * Decrypts and returns the stored password.
 *
 * ADR-006 Decision 4: never part of the page payload. Reaching this function
 * means a person deliberately asked, which is why the request is audited —
 * reading a credential is an event worth recording.
 *
 * The plaintext must never be logged and must never enter an audit snapshot.
 */
async function revealPassword(id: string, context: AuditContext): Promise<Result<string>> {
  const password = await accountsRepository.revealPassword(id);

  if (!password.ok) {
    return password;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: id,
      action: "update",
      after: { event: "password_revealed" },
    },
    context,
  );

  return password;
}

async function getAccountTimeline(id: string, pagination: PaginationInput) {
  return profilesRepository.listAccountEvents(id, pagination);
}

/** Converts Zod issues into a ValidationError carrying field-level messages. */
function toValidationError(
  issues: readonly { path: PropertyKey[]; message: string }[],
  message: string,
): ValidationError {
  const fieldErrors: Record<string, string> = {};

  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in fieldErrors)) {
      fieldErrors[field] = issue.message;
    }
  }

  return new ValidationError(message, { fieldErrors });
}

export const accountsService = {
  listAccounts,
  getAccountDetail,
  createAccount,
  updateAccount,
  archiveAccount,
  restoreAccount,
  softDeleteAccount,
  revealPassword,
  getAccountTimeline,
} as const;
