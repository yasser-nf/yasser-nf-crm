import "server-only";

import { desc, eq } from "drizzle-orm";

import { USER_ROLES } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { databaseAdapter, type Page } from "@/lib/database";
import {
  accounts,
  profileEvents,
  profiles,
  type AccountRow,
  type CustomerRow,
  type ProfileEventRow,
  type ProfileRow,
} from "@/lib/drizzle/schema";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { formatPhoneForDisplay, normalizePhone } from "@/lib/phone";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  customersRepository,
  type CustomerFilter,
  type CustomerWithStats,
} from "../repositories/customers.repository";
import { customerNotesSchema } from "../validation/customer.schema";
import {
  deriveCustomerStatus,
  expiryUrgency,
  isSubscriptionActive,
  remainingDays,
  type CustomerStatus,
  type ExpiryUrgency,
} from "./customer-status";

/**
 * Customers service.
 *
 * 01_MASTER_RULES.md defines customer identity as the normalized WhatsApp
 * number, and the Phone Engine is the only thing permitted to produce it.
 *
 * `findOrCreateByPhone` predates this module and was added by ADR-007 Decision 3
 * so Quick Prepare had a customer to attach an allocation to. M05 expanded the
 * service into full Customer Management; that method is unchanged, because
 * Quick Prepare still depends on its race-safe behaviour.
 *
 * Status is derived, never stored. See `customer-status.ts` — only `blocked_at`
 * is persisted, because it is the one status nothing else can be inferred from.
 */

export interface FindOrCreateResult {
  readonly customer: CustomerRow;
  /** True when this call created the row. Lets the caller report "new customer". */
  readonly created: boolean;
}

/**
 * Finds a customer by phone, creating one when they are new.
 *
 * Race-safe by construction rather than by checking first. Two workers preparing
 * for the same new customer at the same moment would both see "not found" and
 * both insert; the partial unique index on phone_normalized rejects the loser,
 * and that rejection is handled as "someone else won, read theirs".
 *
 * Checking before inserting cannot fix this — it only narrows the window.
 */
async function findOrCreateByPhone(
  phoneInput: string,
  notes?: string | undefined,
): Promise<Result<FindOrCreateResult>> {
  const phone = normalizePhone(phoneInput);

  if (!phone.ok) {
    return phone;
  }

  const existing = await customersRepository.findByNormalizedPhone(phone.value.normalized);

  if (existing.ok) {
    return ok({ customer: existing.value, created: false });
  }

  /* Anything other than "not found" is a real failure and must surface. */
  if (existing.error.code !== "NOT_FOUND") {
    return existing;
  }

  const created = await customersRepository.create({
    phoneOriginal: phone.value.original,
    phoneNormalized: phone.value.normalized,
    whatsappUrl: phone.value.whatsappUrl,
    ...(notes ? { notes } : {}),
  });

  if (created.ok) {
    return ok({ customer: created.value, created: true });
  }

  /*
   * Lost the race. The other insert succeeded, so their row is the customer —
   * reading it is correct, and reporting a conflict to the worker would be a
   * confusing lie about a customer who now exists.
   */
  if (created.error instanceof ConflictError) {
    const winner = await customersRepository.findByNormalizedPhone(phone.value.normalized);

    if (winner.ok) {
      return ok({ customer: winner.value, created: false });
    }
  }

  return created;
}

/** One allocation, with everything the detail page renders. */
export interface CustomerSubscription {
  readonly profileId: string;
  readonly profileNumber: number;
  readonly profileName: string | null;
  readonly pin: string | null;
  readonly status: ProfileRow["status"];
  readonly saleDate: string | null;
  readonly expirationDate: string | null;
  readonly remainingDays: number | null;
  readonly urgency: ExpiryUrgency;
  readonly isActive: boolean;
  readonly accountId: string;
  readonly accountEmail: string;
  readonly accountStatus: AccountRow["status"];
  readonly accountHealthScore: number;
}

export interface CustomerDetail {
  readonly customer: CustomerRow;
  readonly status: CustomerStatus;
  readonly displayPhone: string;
  readonly subscriptions: readonly CustomerSubscription[];
  readonly activeSubscriptions: readonly CustomerSubscription[];
  readonly expiredSubscriptions: readonly CustomerSubscription[];
  readonly timeline: readonly ProfileEventRow[];
}

async function list(filter: CustomerFilter): Promise<Result<Page<CustomerWithStats>>> {
  return customersRepository.listWithStats(filter);
}

/**
 * Reads a customer with subscriptions and history.
 *
 * Three queries regardless of how many profiles the customer holds: the
 * customer, their profiles joined to accounts, and their events. Loading the
 * account per profile would be the N+1 the brief asks us to avoid.
 */
async function getDetail(id: string, now = new Date()): Promise<Result<CustomerDetail>> {
  const customer = await customersRepository.findById(id);

  if (!customer.ok) {
    return customer;
  }

  const rows = await databaseAdapter.query("customers.detailProfiles", (executor) =>
    executor
      .select({ profile: profiles, account: accounts })
      .from(profiles)
      .innerJoin(accounts, eq(profiles.accountId, accounts.id))
      .where(eq(profiles.customerId, id))
      .orderBy(desc(profiles.saleDate)),
  );

  if (!rows.ok) {
    return rows;
  }

  const events = await databaseAdapter.query("customers.detailEvents", (executor) =>
    executor
      .select()
      .from(profileEvents)
      .where(eq(profileEvents.customerId, id))
      .orderBy(desc(profileEvents.createdAt))
      .limit(100),
  );

  if (!events.ok) {
    return events;
  }

  const subscriptions: CustomerSubscription[] = rows.value.map(({ profile, account }) => ({
    profileId: profile.id,
    profileNumber: profile.profileNumber,
    profileName: profile.profileName,
    pin: profile.pin,
    status: profile.status,
    saleDate: profile.saleDate,
    expirationDate: profile.expirationDate,
    remainingDays: remainingDays(profile.expirationDate, now),
    urgency: expiryUrgency(profile.expirationDate, now),
    isActive: isSubscriptionActive(
      { status: profile.status, expirationDate: profile.expirationDate },
      now,
    ),
    accountId: account.id,
    accountEmail: account.email,
    accountStatus: account.status,
    accountHealthScore: account.healthScore,
  }));

  const phone = normalizePhone(customer.value.phoneOriginal);

  return ok({
    customer: customer.value,
    status: deriveCustomerStatus(customer.value, subscriptions, now),
    displayPhone: phone.ok
      ? formatPhoneForDisplay(phone.value.normalized)
      : customer.value.phoneOriginal,
    subscriptions,
    activeSubscriptions: subscriptions.filter((s) => s.isActive),
    expiredSubscriptions: subscriptions.filter((s) => !s.isActive),
    timeline: events.value,
  });
}

/** Updates the internal note. Every change is audited. */
async function updateNotes(
  id: string,
  notes: string,
  context: AuditContext,
): Promise<Result<CustomerRow>> {
  const parsed = customerNotesSchema.safeParse({ notes });

  if (!parsed.success) {
    return fail(
      new ValidationError("Customer notes failed validation", {
        fieldErrors: { notes: parsed.error.issues[0]?.message ?? "Invalid" },
      }),
    );
  }

  const before = await customersRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const updated = await customersRepository.update(id, { notes: parsed.data.notes });

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    {
      entity: "customer",
      entityId: id,
      action: "update",
      before: before.value,
      after: updated.value,
    },
    context,
  );

  return updated;
}

/**
 * Blocks or unblocks a customer.
 *
 * 01_MASTER_RULES.md restricts administrative actions to Super Admin, and M05
 * states a Worker cannot archive a customer. Blocking is the same class of
 * decision, so it is gated the same way — enforced here rather than by hiding a
 * button, because a Server Action is an endpoint anyone with a session can call.
 */
async function setBlocked(
  id: string,
  blocked: boolean,
  context: AuditContext,
): Promise<Result<CustomerRow>> {
  const permitted = requireSuperAdmin(context.actor, blocked ? "block" : "unblock");

  if (!permitted.ok) {
    return permitted;
  }

  const before = await customersRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const updated = await customersRepository.setBlocked(id, blocked);

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    {
      entity: "customer",
      entityId: id,
      action: "update",
      before: before.value,
      after: updated.value,
    },
    context,
  );

  return updated;
}

/** Archives a customer. Super Admin only, per M05. */
async function archive(id: string, context: AuditContext): Promise<Result<CustomerRow>> {
  const permitted = requireSuperAdmin(context.actor, "archive");

  if (!permitted.ok) {
    return permitted;
  }

  const before = await customersRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const archived = await customersRepository.softDelete(id);

  if (!archived.ok) {
    return archived;
  }

  await auditService.recordOrWarn(
    {
      entity: "customer",
      entityId: id,
      action: "delete",
      before: before.value,
      after: archived.value,
    },
    context,
  );

  return archived;
}

function requireSuperAdmin(actor: AppUser | null, action: string): Result<AppUser> {
  if (!actor) {
    return fail(new ForbiddenError(`No signed-in user for ${action}`));
  }

  if (actor.role !== USER_ROLES.SUPER_ADMIN) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not ${action} a customer`, {
        userMessage: "You do not have permission to do that.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  return ok(actor);
}

export const customersService = {
  findOrCreateByPhone,
  list,
  getDetail,
  updateNotes,
  setBlocked,
  archive,
} as const;
