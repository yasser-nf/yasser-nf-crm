import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { databaseAdapter } from "@/lib/database";
import { decryptSecret } from "@/lib/crypto";
import { customers, profileEvents, profiles } from "@/lib/drizzle/schema";
import { ValidationError } from "@/lib/errors";
import { formatPreparation, type AccountCredential } from "@/lib/clipboard";
import { normalizePhone } from "@/lib/phone";
import { auditService, type AuditContext } from "@/modules/audit";
import { customersService } from "@/modules/customers";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { allocationRepository } from "../repositories/allocation.repository";
import {
  buildAllocationPlan,
  computeExpirationDate,
  todayAsDate,
  type AllocationPlan,
} from "./allocation-engine";
import {
  quickPrepareSchema,
  replaceAllocationSchema,
  type QuickPrepareInput,
} from "../validation/quick-prepare.schema";

/**
 * Quick Prepare service.
 *
 * The flagship flow. 01_MASTER_RULES.md targets under five seconds end to end,
 * which is why the expensive parts — candidate selection and every write — happen
 * in exactly one round trip each rather than per profile.
 *
 * ADR-007 Decision 4: preview reads without locks; confirmation re-selects
 * inside a transaction holding row locks. The preview is a suggestion, the
 * confirmation is the truth.
 */

export interface PreparedProfile {
  readonly profileId: string;
  readonly profileNumber: number;
  readonly profileName: string | null;
  readonly pin: string | null;
}

export interface PreparedAccount {
  readonly accountId: string;
  readonly email: string;
  readonly password: string;
  readonly profiles: readonly PreparedProfile[];
}

export interface PreparationPreview {
  readonly accounts: readonly {
    readonly accountId: string;
    readonly email: string;
    readonly healthScore: number;
    readonly profileNumbers: readonly number[];
  }[];
  readonly requested: number;
  readonly availableTotal: number;
}

export interface PreparationResult {
  readonly customerId: string;
  readonly customerPhone: string;
  readonly whatsappUrl: string;
  readonly customerIsNew: boolean;
  readonly expirationDate: string;
  readonly durationDays: number;
  readonly accounts: readonly PreparedAccount[];
  /** The standardised block, ready to paste. */
  readonly clipboardText: string;
}

/** Turns a short plan into the failure a worker should see. */
function shortStockError(plan: AllocationPlan): ValidationError {
  return new ValidationError(
    `Requested ${plan.requested} profiles, only ${plan.availableTotal} allocatable`,
    {
      userMessage:
        plan.availableTotal === 0
          ? "No profiles are available on healthy accounts right now."
          : `Only ${plan.availableTotal} profile${plan.availableTotal === 1 ? " is" : "s are"} available right now.`,
      fieldErrors: { profileCount: `Maximum available: ${plan.availableTotal}` },
    },
  );
}

/**
 * Shows what the engine would allocate, without taking anything.
 *
 * No locks and no writes, so an abandoned preview costs nothing and strands no
 * stock. The credentials are deliberately absent — a preview is a plan, not a
 * delivery, and decrypting passwords for something that may never be confirmed
 * would spread secrets for no reason.
 */
async function preview(profileCount: number): Promise<Result<PreparationPreview>> {
  const candidates = await allocationRepository.findCandidates();

  if (!candidates.ok) {
    return candidates;
  }

  const plan = buildAllocationPlan(candidates.value, profileCount);

  if (plan.isShort) {
    return fail(shortStockError(plan));
  }

  return ok({
    accounts: plan.slices.map((slice) => ({
      accountId: slice.account.id,
      email: slice.account.email,
      healthScore: slice.account.healthScore,
      profileNumbers: slice.profiles.map((profile) => profile.profileNumber),
    })),
    requested: plan.requested,
    availableTotal: plan.availableTotal,
  });
}

/**
 * Allocates profiles and records the sale.
 *
 * Everything below the customer lookup happens in one transaction: selection
 * under lock, the profile updates, the events, and the customer's purchase
 * timestamps. If any part fails, none of it happened — a customer is never left
 * holding half an order.
 *
 * The customer is resolved before the transaction opens. Creating them inside it
 * would hold profile locks across a second write path for no benefit, and a
 * customer created for an allocation that then fails is harmless.
 */
async function confirm(input: unknown, context: AuditContext): Promise<Result<PreparationResult>> {
  const parsed = quickPrepareSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const request: QuickPrepareInput = parsed.data;

  const phone = normalizePhone(request.phone);

  if (!phone.ok) {
    return phone;
  }

  const customerResult = await customersService.findOrCreateByPhone(request.phone);

  if (!customerResult.ok) {
    return customerResult;
  }

  const { customer, created: customerIsNew } = customerResult.value;

  const now = new Date();
  const saleDate = todayAsDate(now);
  const expirationDate = computeExpirationDate(now, request.durationDays);

  const allocation = await databaseAdapter.transaction("quickPrepare.confirm", async (executor) => {
    /*
     * Re-select under lock. The preview the worker saw may be stale, and the
     * only stock that matters is the stock this transaction actually holds.
     */
    const candidates = await allocationRepository.lockCandidates(executor);
    const plan = buildAllocationPlan(candidates, request.profileCount);

    if (plan.isShort) {
      /* Throwing rolls the transaction back and releases every lock. */
      throw shortStockError(plan);
    }

    const profileIds = plan.slices.flatMap((slice) => slice.profiles.map((profile) => profile.id));

    /*
     * One UPDATE for every profile in the sale rather than one per profile.
     * A five-profile order becomes a single statement.
     */
    await executor
      .update(profiles)
      .set({
        status: "sold",
        customerId: customer.id,
        workerId: context.actor?.id ?? null,
        saleDate,
        expirationDate,
        durationDays: request.durationDays,
        updatedAt: sql`now()`,
      })
      .where(inArray(profiles.id, profileIds));

    /* One INSERT for every event. */
    await executor.insert(profileEvents).values(
      plan.slices.flatMap((slice) =>
        slice.profiles.map((profile) => ({
          accountId: slice.account.id,
          profileId: profile.id,
          eventType: "sold" as const,
          userId: context.actor?.id ?? null,
          customerId: customer.id,
          metadata: {
            durationDays: request.durationDays,
            saleDate,
            expirationDate,
            profileNumber: profile.profileNumber,
          },
          ...(request.notes ? { notes: request.notes } : {}),
        })),
      ),
    );

    /*
     * Purchase bookends. ADR-007 Decision 2 defers the orders table, so these
     * are the only record of when this customer last bought anything.
     */
    await executor
      .update(customers)
      .set({
        lastPurchaseAt: sql`now()`,
        firstPurchaseAt: sql`coalesce(${customers.firstPurchaseAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(eq(customers.id, customer.id));

    return plan;
  });

  if (!allocation.ok) {
    return allocation;
  }

  const credentials = await buildCredentials(allocation.value);

  if (!credentials.ok) {
    return credentials;
  }

  for (const slice of allocation.value.slices) {
    await auditService.recordOrWarn(
      {
        entity: "account",
        entityId: slice.account.id,
        action: "update",
        after: {
          event: "quick_prepare_allocation",
          customerId: customer.id,
          profileNumbers: slice.profiles.map((profile) => profile.profileNumber),
          durationDays: request.durationDays,
          expirationDate,
        },
      },
      context,
    );
  }

  return ok({
    customerId: customer.id,
    customerPhone: phone.value.normalized,
    whatsappUrl: phone.value.whatsappUrl,
    customerIsNew,
    expirationDate,
    durationDays: request.durationDays,
    accounts: credentials.value,
    clipboardText: formatPreparation(
      credentials.value.map((account): AccountCredential => ({
        email: account.email,
        password: account.password,
        profiles: account.profiles.map((profile) => ({
          profileNumber: profile.profileNumber,
          pin: profile.pin,
          profileName: profile.profileName,
        })),
      })),
    ),
  });
}

/**
 * Swaps an allocation onto different stock.
 *
 * Used when the account turns out to be broken: payment problem, wrong password,
 * invalid email, or something else. The customer keeps their duration; only the
 * credentials change.
 *
 * The release and the re-allocation share one transaction. Releasing first in
 * its own transaction would briefly expose profiles that are about to be
 * reassigned, and a failure after that point would lose the customer's order
 * entirely.
 */
async function replaceAllocation(
  input: unknown,
  context: AuditContext,
): Promise<Result<PreparationResult>> {
  const parsed = replaceAllocationSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const { accountId, customerId, reason } = parsed.data;

  const customerRow = await databaseAdapter.query("quickPrepare.readCustomer", (executor) =>
    executor.select().from(customers).where(eq(customers.id, customerId)).limit(1),
  );

  if (!customerRow.ok) {
    return customerRow;
  }

  const customer = customerRow.value[0];

  if (!customer) {
    return fail(
      new ValidationError("Customer not found for replacement", {
        userMessage: "That customer no longer exists.",
      }),
    );
  }

  const now = new Date();

  const replacement = await databaseAdapter.transaction(
    "quickPrepare.replace",
    async (executor) => {
      /* The profiles this customer currently holds on the failing account. */
      const held = await executor
        .select()
        .from(profiles)
        .where(and(eq(profiles.accountId, accountId), eq(profiles.customerId, customerId)))
        .for("update");

      if (held.length === 0) {
        throw new ValidationError("No profiles held by this customer on that account", {
          userMessage: "This customer does not hold any profiles on that account.",
        });
      }

      const first = held[0];

      if (!first) {
        throw new ValidationError("No profiles to replace");
      }

      /*
       * Carry the original terms forward. The customer bought a duration, and a
       * replacement is a fix for our problem, not a new sale — restarting the
       * clock would silently extend it and lose the real expiry.
       */
      const durationDays = first.durationDays ?? 30;
      const expirationDate = first.expirationDate ?? computeExpirationDate(now, durationDays);
      const saleDate = first.saleDate ?? todayAsDate(now);

      const candidates = await allocationRepository.lockCandidates(executor);

      /* Never replace like for like — the failing account must not win again. */
      const eligible = candidates.filter((candidate) => candidate.account.id !== accountId);
      const plan = buildAllocationPlan(eligible, held.length);

      if (plan.isShort) {
        throw shortStockError(plan);
      }

      /* Release the old profiles. Available requires no customer — see the check constraint. */
      await executor
        .update(profiles)
        .set({
          status: "available",
          customerId: null,
          workerId: null,
          saleDate: null,
          expirationDate: null,
          durationDays: null,
          updatedAt: sql`now()`,
        })
        .where(
          inArray(
            profiles.id,
            held.map((profile) => profile.id),
          ),
        );

      /* The cancellation is history and must be recorded before the new sale. */
      await executor.insert(profileEvents).values(
        held.map((profile) => ({
          accountId,
          profileId: profile.id,
          eventType: "replaced" as const,
          userId: context.actor?.id ?? null,
          customerId,
          metadata: {
            outcome: "cancelled",
            reason: reason ?? "account_problem",
            profileNumber: profile.profileNumber,
          },
        })),
      );

      const newProfileIds = plan.slices.flatMap((slice) =>
        slice.profiles.map((profile) => profile.id),
      );

      await executor
        .update(profiles)
        .set({
          status: "sold",
          customerId,
          workerId: context.actor?.id ?? null,
          saleDate,
          expirationDate,
          durationDays,
          updatedAt: sql`now()`,
        })
        .where(inArray(profiles.id, newProfileIds));

      await executor.insert(profileEvents).values(
        plan.slices.flatMap((slice) =>
          slice.profiles.map((profile) => ({
            accountId: slice.account.id,
            profileId: profile.id,
            eventType: "replaced" as const,
            userId: context.actor?.id ?? null,
            customerId,
            metadata: {
              outcome: "reallocated",
              replacesAccountId: accountId,
              profileNumber: profile.profileNumber,
              expirationDate,
            },
          })),
        ),
      );

      return { plan, expirationDate, durationDays };
    },
  );

  if (!replacement.ok) {
    return replacement;
  }

  const credentials = await buildCredentials(replacement.value.plan);

  if (!credentials.ok) {
    return credentials;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: accountId,
      action: "update",
      after: {
        event: "quick_prepare_replacement",
        customerId,
        reason: reason ?? "account_problem",
        replacedWith: replacement.value.plan.slices.map((slice) => slice.account.id),
      },
    },
    context,
  );

  return ok({
    customerId,
    customerPhone: customer.phoneNormalized,
    whatsappUrl: customer.whatsappUrl,
    customerIsNew: false,
    expirationDate: replacement.value.expirationDate,
    durationDays: replacement.value.durationDays,
    accounts: credentials.value,
    clipboardText: formatPreparation(
      credentials.value.map((account): AccountCredential => ({
        email: account.email,
        password: account.password,
        profiles: account.profiles.map((profile) => ({
          profileNumber: profile.profileNumber,
          pin: profile.pin,
          profileName: profile.profileName,
        })),
      })),
    ),
  });
}

/**
 * Decrypts the credentials for an allocated plan.
 *
 * Runs after the transaction commits. Decryption is CPU work with no bearing on
 * the outcome, and doing it inside the transaction would hold profile locks
 * while it ran.
 */
async function buildCredentials(plan: AllocationPlan): Promise<Result<readonly PreparedAccount[]>> {
  const prepared: PreparedAccount[] = [];

  for (const slice of plan.slices) {
    const password = decryptSecret(slice.account.passwordEncrypted);

    if (!password.ok) {
      return password;
    }

    prepared.push({
      accountId: slice.account.id,
      email: slice.account.email,
      password: password.value,
      profiles: slice.profiles.map((profile) => ({
        profileId: profile.id,
        profileNumber: profile.profileNumber,
        profileName: profile.profileName,
        pin: profile.pin,
      })),
    });
  }

  return ok(prepared);
}

/** Reads current allocatable stock, for the page header. */
async function availableStock(): Promise<Result<number>> {
  return allocationRepository.countAvailable();
}

function toValidationError(
  issues: readonly { path: PropertyKey[]; message: string }[],
): ValidationError {
  const fieldErrors: Record<string, string> = {};

  for (const issue of issues) {
    const field = issue.path[0];
    if (typeof field === "string" && !(field in fieldErrors)) {
      fieldErrors[field] = issue.message;
    }
  }

  return new ValidationError("Quick Prepare input failed validation", { fieldErrors });
}

export const quickPrepareService = {
  preview,
  confirm,
  replaceAllocation,
  availableStock,
} as const;
