import "server-only";

import { randomUUID } from "node:crypto";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { databaseAdapter } from "@/lib/database";
import { remainingDays, type DateString } from "@/lib/dates";
import {
  profileEvents,
  type AccountRow,
  type CustomerRow,
  type ProfileRow,
} from "@/lib/drizzle/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  accountCanAllocate,
  profileCellState,
  toAccountView,
  toProfileView,
  type AccountView,
  type ProfileCellState,
  type ProfileView,
} from "@/modules/accounts";
import { auditService, type AuditContext } from "@/modules/audit";
import { idempotency, isReplay, type Receipt } from "@/modules/idempotency";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { renewalRepository, type RenewalTarget } from "../repositories/renewal.repository";
import {
  accountSearchSchema,
  confirmRenewalSchema,
  renewalPreviewSchema,
} from "../validation/renewal.schema";
import { planRenewal, type RenewalBasis, type RenewalDuration } from "./renewal-dates";

/**
 * Quick Renewing (M09A).
 *
 * Extends the period on a profile a customer already holds. It never allocates
 * stock, never creates a profile, never touches another slot, and never
 * decrypts a credential — which is why it is its own module rather than a
 * branch inside Quick Prepare, whose protections it must not disturb.
 *
 * The write keeps the invariant `profile-dates.ts` owns: expiration is derived
 * from sale date plus duration, so a renewal restates BOTH the expiry and the
 * duration. Moving the expiry alone would be reverted the next time anyone
 * opened the profile editor, because that screen recomputes the date.
 */

export const QUICK_RENEW_SCOPE = "quick_renew.confirm";

const SEARCH_LIMIT = 20;

export interface RenewAccountMatch {
  readonly account: AccountView;
  readonly hasBlockingProblem: boolean;
}

export interface RenewProfileSlot {
  readonly profile: ProfileView;
  readonly state: ProfileCellState;
  readonly customer: {
    readonly id: string;
    readonly name: string | null;
    readonly phone: string;
    readonly whatsappUrl: string;
  } | null;
  /** Whether this slot can be renewed at all, and why not. */
  readonly renewable: boolean;
  readonly blockedReason: string | null;
}

export interface AccountProfiles {
  readonly account: AccountView;
  readonly hasBlockingProblem: boolean;
  readonly profiles: readonly RenewProfileSlot[];
}

export interface RenewalPreview {
  readonly profile: ProfileView;
  readonly account: AccountView;
  readonly customer: NonNullable<RenewProfileSlot["customer"]>;
  readonly basis: RenewalBasis;
  readonly currentExpirationDate: DateString;
  readonly newExpirationDate: DateString;
  readonly durationLabel: string;
  readonly daysAdded: number;
  readonly remainingDaysBefore: number;
  /** Warnings the operator should read before confirming. Never blocking. */
  readonly warnings: readonly string[];
}

export interface RenewalResult {
  readonly profileId: string;
  readonly profileNumber: number;
  readonly accountEmail: string;
  readonly customerName: string | null;
  readonly customerPhone: string;
  readonly previousExpirationDate: DateString;
  readonly newExpirationDate: DateString;
  readonly durationLabel: string;
  readonly basis: RenewalBasis;
  /** True when this repeats a renewal that had already committed. */
  readonly replayed: boolean;
}

function requireRenewAccess(actor: AppUser | null, action: string): Result<AppUser> {
  if (!actor || !roleHasPermission(actor.role, PERMISSIONS.RENEW_SUBSCRIPTIONS)) {
    return fail(
      new ForbiddenError(`Not permitted to ${action}`, {
        userMessage: "You do not have permission to renew subscriptions.",
      }),
    );
  }

  return ok(actor);
}

function customerOf(customer: CustomerRow | null): RenewProfileSlot["customer"] {
  return customer
    ? {
        id: customer.id,
        name: customer.name,
        phone: customer.phoneOriginal,
        whatsappUrl: customer.whatsappUrl,
      }
    : null;
}

/**
 * Why a slot cannot be renewed, or null when it can.
 *
 * Held-ness is the rule, not the stored status: an `expired` row still names
 * its customer, and renewing it is the entire point of the feature. What
 * cannot be renewed is a slot nobody holds, or one with no period to extend.
 */
function renewalBlocker(profile: ProfileRow, customer: CustomerRow | null): string | null {
  if (!customer || !profile.customerId) {
    return "No customer holds this profile — sell it through Quick Prepare instead.";
  }

  if (!profile.expirationDate) {
    return "This profile has no recorded expiry date, so there is no period to extend.";
  }

  if (!profile.saleDate) {
    return "This profile has no recorded sale date, so a renewed period cannot be dated.";
  }

  if (profile.status === "available") {
    return "This profile is marked available and is not currently sold.";
  }

  return null;
}

/** Accounts whose email matches. Passwords never leave the repository. */
async function searchAccounts(
  input: unknown,
  actor: AppUser | null,
): Promise<Result<readonly RenewAccountMatch[]>> {
  const permitted = requireRenewAccess(actor, "search accounts for renewal");

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = accountSearchSchema.safeParse(input);

  if (!parsed.success) {
    return fail(
      new ValidationError("Account search failed validation", {
        fieldErrors: { email: parsed.error.issues[0]?.message ?? "Enter an account email" },
      }),
    );
  }

  const matches = await renewalRepository.searchByEmail(parsed.data.email, SEARCH_LIMIT);

  if (!matches.ok) {
    return matches;
  }

  return ok(
    matches.value.map((match) => ({
      account: toAccountView(match.account),
      hasBlockingProblem: match.hasBlockingProblem,
    })),
  );
}

/** One account's slots, each with whoever holds it and whether it can be renewed. */
async function listProfiles(
  accountId: string,
  actor: AppUser | null,
  now = new Date(),
): Promise<Result<AccountProfiles>> {
  const permitted = requireRenewAccess(actor, "view profiles for renewal");

  if (!permitted.ok) {
    return permitted;
  }

  const found = await renewalRepository.findAccount(accountId);

  if (!found.ok) {
    return found;
  }

  if (!found.value) {
    return fail(new NotFoundError("Account not found"));
  }

  const rows = await renewalRepository.profilesForAccount(accountId);

  if (!rows.ok) {
    return rows;
  }

  const { account, hasBlockingProblem } = found.value;
  const canAllocate = accountCanAllocate(account, hasBlockingProblem, now);

  return ok({
    account: toAccountView(account),
    hasBlockingProblem,
    profiles: rows.value.map(({ profile, customer }) => {
      const blocker = renewalBlocker(profile, customer);

      return {
        profile: toProfileView(profile),
        state: profileCellState(profile, account, now, canAllocate),
        customer: customerOf(customer),
        renewable: blocker === null,
        blockedReason: blocker,
      };
    }),
  });
}

/**
 * Everything the confirm will check, applied to the current row.
 *
 * Shared by the preview and the confirm so the operator cannot be shown a
 * renewal the commit would refuse — and so the commit cannot accept one the
 * preview would have refused. The commit calls this against the LOCKED row.
 */
function evaluate(
  target: RenewalTarget,
  duration: RenewalDuration,
  now: Date,
): Result<{
  readonly plan: NonNullable<ReturnType<typeof planRenewal>>;
  readonly warnings: string[];
}> {
  const { profile, account, customer } = target;

  const blocker = renewalBlocker(profile, customer);

  if (blocker) {
    return fail(new ValidationError("Profile cannot be renewed", { userMessage: blocker }));
  }

  /*
   * An account with an open, in-progress or waiting problem cannot be
   * allocated from (`accountCanAllocate`). Extending a paid period on it is
   * the same promise of service, so it follows the same rule rather than
   * quietly bypassing a payment or password problem.
   */
  if (target.hasBlockingProblem) {
    return fail(
      new ValidationError("Account has a blocking problem", {
        userMessage:
          "This account has an open problem, so its subscriptions cannot be renewed. " +
          "Resolve the problem first, or replace the customer's account.",
      }),
    );
  }

  if (account.status !== "healthy") {
    return fail(
      new ValidationError(`Account is ${account.status}`, {
        userMessage: "This account is not healthy, so its subscriptions cannot be renewed.",
      }),
    );
  }

  const plan = planRenewal({
    saleDate: profile.saleDate,
    currentExpiration: profile.expirationDate,
    duration,
    now,
  });

  if (!plan || plan.durationDays === null || plan.durationDays <= 0) {
    return fail(
      new ValidationError("Renewal dates could not be computed", {
        userMessage: "The renewed dates could not be computed for this profile.",
      }),
    );
  }

  /*
   * The account's own coverage must reach the new expiry. This is the M13 rule
   * Quick Prepare enforces for a new sale, applied to an extended one: selling
   * a year on an account that stops working in two months is the same bug.
   */
  const accountDaysLeft = remainingDays(account.validUntil, now);
  const warnings: string[] = [];

  if (accountDaysLeft !== null) {
    const neededDays = remainingDays(plan.newExpiration, now) ?? 0;

    if (neededDays > accountDaysLeft) {
      return fail(
        new ValidationError("Renewal outlasts the account's validity", {
          userMessage:
            `This account is only covered for ${accountDaysLeft} more day` +
            `${accountDaysLeft === 1 ? "" : "s"}, and the renewal would run ${neededDays} days. ` +
            "Extend the account's validity first, or renew for a shorter period.",
        }),
      );
    }
  }

  if (plan.basis === "restarts") {
    warnings.push(
      `This subscription expired on ${plan.currentExpiration}. The renewed period runs from today, ` +
        "so the lapsed days are not restored.",
    );
  }

  return ok({ plan, warnings });
}

/** What the operator sees before confirming. Reads only; writes nothing. */
async function preview(
  input: unknown,
  actor: AppUser | null,
  now = new Date(),
): Promise<Result<RenewalPreview>> {
  const permitted = requireRenewAccess(actor, "preview a renewal");

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = renewalPreviewSchema.safeParse(input);

  if (!parsed.success) {
    return fail(new ValidationError("Renewal preview failed validation"));
  }

  const target = await renewalRepository.findTarget(parsed.data.profileId);

  if (!target.ok) {
    return target;
  }

  if (!target.value) {
    return fail(new NotFoundError("Profile not found"));
  }

  const evaluated = evaluate(target.value, parsed.data.duration, now);

  if (!evaluated.ok) {
    return evaluated;
  }

  const { plan, warnings } = evaluated.value;
  const customer = customerOf(target.value.customer);

  if (!customer) {
    return fail(new ValidationError("Profile has no customer"));
  }

  return ok({
    profile: toProfileView(target.value.profile),
    account: toAccountView(target.value.account),
    customer,
    basis: plan.basis,
    currentExpirationDate: plan.currentExpiration,
    newExpirationDate: plan.newExpiration,
    durationLabel: plan.description,
    daysAdded: plan.daysAdded,
    remainingDaysBefore: remainingDays(plan.currentExpiration, now) ?? 0,
    warnings,
  });
}

function resultFrom(
  profile: ProfileRow,
  account: AccountRow,
  customer: CustomerRow | null,
  plan: {
    currentExpiration: string;
    newExpiration: string;
    description: string;
    basis: RenewalBasis;
  },
  replayed: boolean,
): RenewalResult {
  return {
    profileId: profile.id,
    profileNumber: profile.profileNumber,
    accountEmail: account.email,
    customerName: customer?.name ?? null,
    customerPhone: customer?.phoneOriginal ?? "",
    previousExpirationDate: plan.currentExpiration,
    newExpirationDate: plan.newExpiration,
    durationLabel: plan.description,
    basis: plan.basis,
    replayed,
  };
}

/** Replays a renewal that already committed, without renewing again. */
async function replayRenewal(receipt: Receipt): Promise<Result<RenewalResult>> {
  const recorded = receipt.result as Partial<RenewalResult> & { profileId?: string };

  if (!recorded.profileId || !recorded.newExpirationDate) {
    return fail(
      new ConflictError("This renewal already completed", {
        userMessage: "This renewal was already applied.",
      }),
    );
  }

  const target = await renewalRepository.findTarget(recorded.profileId);

  if (!target.ok) {
    return target;
  }

  /*
   * The live row must still carry the expiry the receipt recorded. If it moved
   * on — another renewal, a replacement, an unassignment — the stored result is
   * no longer a description of reality, and repeating it would mislead.
   */
  if (!target.value || target.value.profile.expirationDate !== recorded.newExpirationDate) {
    return fail(
      new ConflictError("Renewal replay no longer matches the live profile", {
        userMessage:
          "This renewal was already applied, and the profile has changed since. " +
          "Look it up again to see its current expiry.",
      }),
    );
  }

  return ok({
    profileId: recorded.profileId,
    profileNumber: target.value.profile.profileNumber,
    accountEmail: target.value.account.email,
    customerName: target.value.customer?.name ?? null,
    customerPhone: target.value.customer?.phoneOriginal ?? "",
    previousExpirationDate: recorded.previousExpirationDate ?? "",
    newExpirationDate: recorded.newExpirationDate,
    durationLabel: recorded.durationLabel ?? "",
    basis: recorded.basis ?? "continues",
    replayed: true,
  });
}

/**
 * Applies the renewal.
 *
 * Everything that decides the outcome happens inside one transaction, against
 * the LOCKED profile row: the receipt, the re-read, every eligibility rule, the
 * stale-preview check, the write and the profile event. The audit entry is
 * written after commit, so a failed renewal never leaves a trail claiming it
 * succeeded.
 */
async function confirm(input: unknown, context: AuditContext): Promise<Result<RenewalResult>> {
  const permitted = requireRenewAccess(context.actor, "renew a subscription");

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = confirmRenewalSchema.safeParse(input);

  if (!parsed.success) {
    return fail(
      new ValidationError("Renewal failed validation", {
        userMessage: "That renewal request was not valid. Look the profile up again.",
      }),
    );
  }

  const request = parsed.data;
  const now = new Date();

  const operation = idempotency.operation(
    QUICK_RENEW_SCOPE,
    request.operationId ?? randomUUID(),
    context.actor?.id ?? null,
    {
      profileId: request.profileId,
      duration: request.duration,
      expectedExpirationDate: request.expectedExpirationDate,
    },
  );

  const prior = await idempotency.lookup(operation);

  if (!prior.ok) {
    return prior;
  }

  if (prior.value) {
    return replayRenewal(prior.value);
  }

  const committed = await databaseAdapter.transaction("quickRenew.confirm", async (executor) => {
    /* The receipt first: a repeat stops here and replays instead of renewing twice. */
    await idempotency.begin(executor, operation);

    const target = await renewalRepository.lockTarget(executor, request.profileId);

    if (!target) {
      throw new NotFoundError("Profile not found");
    }

    /*
     * The preview must still describe this row. Checked against the LOCKED
     * expiry, so a renewal that landed between the operator's preview and this
     * commit is caught here rather than silently overwritten.
     */
    if (target.profile.expirationDate !== request.expectedExpirationDate) {
      throw new ConflictError("The profile changed since it was previewed", {
        userMessage:
          "This subscription changed while you were reviewing it — someone may have already " +
          "renewed it. Look it up again before continuing.",
      });
    }

    const evaluated = evaluate(target, request.duration, now);

    if (!evaluated.ok) {
      throw evaluated.error;
    }

    const { plan } = evaluated.value;
    const durationDays = plan.durationDays;

    if (durationDays === null) {
      throw new ValidationError("Renewal dates could not be computed");
    }

    const before = target.profile;

    const updated = await renewalRepository.applyRenewal(executor, before.id, {
      expirationDate: plan.newExpiration,
      durationDays,
    });

    if (!updated) {
      throw new ConflictError("The profile could not be renewed");
    }

    /*
     * The existing `extended` event, with the same from/to shape the profile
     * editor writes — one history for a moved subscription, whichever screen
     * moved it. Inside the transaction: a renewal with no event is a renewal
     * nobody can explain afterwards.
     */
    await executor.insert(profileEvents).values({
      accountId: before.accountId,
      profileId: before.id,
      eventType: "extended",
      userId: context.actor?.id ?? null,
      customerId: before.customerId,
      metadata: {
        event: "quick_renewal",
        basis: plan.basis,
        duration: plan.description,
        from: {
          saleDate: before.saleDate,
          expirationDate: before.expirationDate,
          durationDays: before.durationDays,
        },
        to: {
          saleDate: updated.saleDate,
          expirationDate: updated.expirationDate,
          durationDays: updated.durationDays,
        },
      },
    });

    /*
     * References only. The replay re-reads the account, customer and slot from
     * the live rows, so copying a name or a phone number into a second table
     * would duplicate personal data that nothing reads — the same rule M08's
     * receipts follow.
     */
    await idempotency.complete(executor, operation, {
      profileId: updated.id,
      previousExpirationDate: plan.currentExpiration,
      newExpirationDate: plan.newExpiration,
      durationLabel: plan.description,
      basis: plan.basis,
    });

    return { before, updated, account: target.account, customer: target.customer, plan };
  });

  if (!committed.ok) {
    return isReplay(committed.error) ? replayRenewal(committed.error.receipt) : committed;
  }

  const { before, updated, account, customer, plan } = committed.value;

  await auditService.recordOrWarn(
    {
      entity: "profile",
      entityId: updated.id,
      action: "update",
      before: { ...before, event: "quick_renewal" },
      after: { ...updated, event: "quick_renewal", customerId: updated.customerId },
    },
    context,
  );

  return ok(resultFrom(updated, account, customer, plan, false));
}

export const quickRenewService = { searchAccounts, listProfiles, preview, confirm } as const;
