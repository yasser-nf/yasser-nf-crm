import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import { databaseAdapter } from "@/lib/database";
import { accounts, profiles, type ProfileEventRow, type ProfileRow } from "@/lib/drizzle/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import { customersService } from "@/modules/customers";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { profilesRepository } from "../repositories/profiles.repository";
import { profileEditSchema } from "../validation/profile.schema";
import { allocationFitsAccount, isSellableSlot } from "./account-validity";
import { resolveExpirationDate } from "./profile-dates";

/**
 * Profiles service.
 *
 * M03 permitted editing only the profile name and PIN. M13 §5 adds the
 * allocation fields — customer, sale date, expiration, duration — and with them
 * the obligation that made the original restriction safe: an editor that can
 * write an expiration date can create an allocation the allocation engine would
 * have refused.
 *
 * So this file is a CONSUMER of the allocation rules, never a second copy of
 * them. It reuses `allocationFitsAccount` and `isSellableSlot` from
 * account-validity, which are the same functions Quick Prepare and
 * `evaluateAllocation` go through. There is no date arithmetic here.
 *
 * WHAT IT REFUSES, AND WHY
 *
 *   - an expiration beyond the account's own valid_until — the allocation would
 *     outlive the stock carrying it, which is the exact thing M13 §1 exists to
 *     prevent
 *   - an expiration before the sale date — mirrors profiles_expiry_after_sale
 *   - clearing the customer from a sold profile — that is a release, and a
 *     release belongs to Quick Replace where it is transactional and audited as
 *     one. Silently blanking the column would strand the customer and violate
 *     profiles_held_requires_customer.
 *   - allocating a slot above accounts.profile_slots — a not-for-sale slot stays
 *     not for sale; its name, PIN and notes remain editable
 *
 * CONCURRENCY
 *
 * Everything happens inside one transaction that re-reads the profile FOR
 * UPDATE. The browser's copy of the row is treated as a suggestion: a form left
 * open while Quick Prepare sold the profile cannot overwrite the newer state,
 * because the validation runs against what the lock returns rather than against
 * what was submitted.
 *
 * Every accepted change writes a profile_event. ADR-006 Decision 1 makes
 * profile_events the only event source, so a change that skips one is invisible
 * in both the profile history and the account timeline.
 */

export interface ProfileUpdateResult {
  readonly profile: ProfileRow;
  /** Events written for this change, in the order they were recorded. */
  readonly events: readonly ProfileEventRow[];
}

/** A field-level failure, shaped so the dialog can render it beside the input. */
function invalid(field: string, message: string, userMessage?: string): ValidationError {
  return new ValidationError(message, {
    ...(userMessage === undefined ? {} : { userMessage }),
    fieldErrors: { [field]: message },
  });
}

/**
 * Updates a profile's identity and, where permitted, its allocation.
 *
 * Name and PIN are recorded as separate events. A single "profile updated"
 * entry would lose which field moved, and the enum already distinguishes
 * `name_changed` from `pin_changed`.
 *
 * The PIN is deliberately NOT stored in the event metadata. 01_MASTER_RULES.md
 * makes the PIN searchable so it is not encrypted, but copying it into an
 * append-only history table would scatter it into rows nothing ever cleans up.
 */
async function updateProfile(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<ProfileUpdateResult>> {
  const parsed = profileEditSchema.safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }

    return fail(new ValidationError("Profile update failed validation", { fieldErrors }));
  }

  const changes = parsed.data;

  /*
   * Resolved BEFORE the transaction opens, exactly as Quick Prepare does it:
   * creating a customer inside the transaction would hold a profile lock across
   * a second write path, and a customer created for an edit that then fails is
   * harmless.
   */
  let resolvedCustomerId: string | undefined;

  if (changes.customerPhone !== undefined) {
    const customer = await customersService.findOrCreateByPhone(changes.customerPhone);

    if (!customer.ok) {
      return fail(
        invalid(
          "customerPhone",
          customer.error.userMessage,
          "That phone number could not be used. Check the format and try again.",
        ),
      );
    }

    resolvedCustomerId = customer.value.customer.id;
  }

  const outcome = await databaseAdapter.transaction("profiles.update", async (executor) => {
    /*
     * The authoritative read. Everything below validates against THIS row, not
     * against whatever the browser had when the dialog opened.
     */
    const locked = await executor
      .select()
      .from(profiles)
      .where(eq(profiles.id, id))
      .for("update")
      .limit(1);

    const previous = locked[0];

    if (!previous) {
      throw new ValidationError(`Profile ${id} not found`, {
        userMessage: "That profile no longer exists.",
      });
    }

    const accountRows = await executor
      .select()
      .from(accounts)
      .where(eq(accounts.id, previous.accountId))
      .limit(1);

    const account = accountRows[0];

    if (!account) {
      throw new ValidationError("The account for this profile no longer exists");
    }

    const sellable = isSellableSlot(previous, account);

    /* The state the row would have after applying the change. */
    const saleDate = changes.saleDate ?? previous.saleDate;
    const durationDays = changes.durationDays ?? previous.durationDays;

    /*
     * Expiration is derived, never accepted.
     *
     * Sale date plus duration is the source of truth, so whatever the client
     * sent for expirationDate is recomputed here. Storing it as an independent
     * field is what let the three drift apart: changing the duration alone left
     * the old expiration in place, and the row then disagreed with itself for
     * every screen that reads it.
     *
     * Deriving before the checks below is deliberate. The account-validity rule
     * and the expiry-after-sale rule must both judge the date that will
     * actually be written, not the one that was submitted.
     *
     * Only derivable when both halves are known. A profile carrying a sale date
     * but no duration keeps whatever it had — there is nothing to compute from,
     * and blanking it would destroy information the operator never touched.
     */
    const derivedExpiration = resolveExpirationDate(
      saleDate,
      durationDays,
      changes.expirationDate ?? previous.expirationDate,
    );

    const next = {
      profileName: changes.profileName ?? previous.profileName,
      pin: changes.pin ?? previous.pin,
      notes: changes.notes ?? previous.notes,
      customerId: resolvedCustomerId ?? previous.customerId,
      saleDate,
      expirationDate: derivedExpiration,
      durationDays,
    };

    const touchesAllocation =
      changes.customerPhone !== undefined ||
      changes.saleDate !== undefined ||
      changes.expirationDate !== undefined ||
      changes.durationDays !== undefined;

    if (touchesAllocation) {
      /*
       * A slot above profile_slots is not stock. Its label, PIN and notes stay
       * editable — an operator may still want to name it — but attaching a
       * customer or a date to it would make it look allocated in every screen
       * that reads dates, while the allocator correctly refuses to sell it.
       */
      if (!sellable) {
        throw invalid(
          "customerPhone",
          `Profile ${previous.profileNumber} is not for sale on this account`,
          `This account sells ${account.profileSlots} profiles, so profile ${previous.profileNumber} cannot hold an allocation. Raise the sellable profile count first.`,
        );
      }

      /* Mirrors profiles_expiry_after_sale, as a field error rather than a 500. */
      if (
        next.saleDate !== null &&
        next.expirationDate !== null &&
        next.expirationDate < next.saleDate
      ) {
        throw invalid(
          "expirationDate",
          "Expiration cannot be before the sale date",
          "The subscription would end before it starts.",
        );
      }

      /*
       * THE RULE THIS METHOD EXISTS TO ENFORCE. The same one Quick Prepare
       * applies as `requested <= remaining`, measured by the same helper.
       */
      if (!allocationFitsAccount(account, next.expirationDate, new Date())) {
        throw invalid(
          "expirationDate",
          "Expiration is beyond the account's own validity",
          `This account is only valid until ${account.validUntil}. An allocation cannot outlive the account carrying it.`,
        );
      }

      /*
       * Releasing is not editing. profiles_held_requires_customer would reject
       * it anyway, but a constraint violation surfaces as a database error —
       * this says what to do instead.
       */
      const isHeld =
        previous.status === "sold" ||
        previous.status === "reserved" ||
        previous.status === "expiring_soon";

      if (isHeld && next.customerId === null) {
        throw invalid(
          "customerPhone",
          "A sold profile must keep its customer",
          "Use Replace account to move this customer, rather than clearing them here.",
        );
      }
    }

    /*
     * Attaching a customer IS an allocation, so the status has to say so.
     *
     * `profiles_held_requires_customer` permits `available` only with a null
     * customer — writing the id while leaving the status alone produces a row
     * the database refuses, and rightly: a profile that belongs to somebody but
     * reads "available" is the shape that double-sells.
     *
     * This is the same transition Quick Prepare performs when it sells. It is
     * NOT a manual status edit: `status` is absent from the edit schema, and
     * `expired` is never written here — expiry stays derived from the date
     * (ADR-013 D2).
     */
    const becomesHeld = previous.customerId === null && next.customerId !== null;

    const updated = await executor
      .update(profiles)
      .set({
        profileName: next.profileName,
        pin: next.pin,
        notes: next.notes,
        customerId: next.customerId,
        saleDate: next.saleDate,
        expirationDate: next.expirationDate,
        durationDays: next.durationDays,
        ...(becomesHeld ? { status: "sold" as const } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(profiles.id, id)))
      .returning();

    const row = updated[0];

    if (!row) {
      throw new ValidationError("Profile update returned no row");
    }

    return { previous, next: row };
  });

  if (!outcome.ok) {
    return outcome;
  }

  const { previous, next } = outcome.value;

  const events = await recordChanges(previous, next, context);

  await auditService.recordOrWarn(
    { entity: "profile", entityId: id, action: "update", before: previous, after: next },
    context,
  );

  return ok({ profile: next, events });
}

/**
 * Writes one profile_event per field that actually moved.
 *
 * Separate events rather than a single "updated", because the enum already
 * distinguishes them and a timeline that says which field changed is worth
 * far more than one that says something did.
 *
 * Values are recorded EXCEPT for the PIN, which is noted as changed and never
 * copied — see the note on updateProfile.
 */
async function recordChanges(
  previous: ProfileRow,
  next: ProfileRow,
  context: AuditContext,
): Promise<readonly ProfileEventRow[]> {
  const events: ProfileEventRow[] = [];
  const userId = context.actor?.id ?? null;

  const write = async (
    eventType: "name_changed" | "pin_changed" | "customer_changed" | "extended",
    metadata: Record<string, unknown>,
    customerId?: string | null,
  ) => {
    const event = await profilesRepository.recordEvent({
      accountId: previous.accountId,
      profileId: previous.id,
      eventType,
      userId,
      ...(customerId === undefined ? {} : { customerId }),
      metadata,
    });

    if (event.ok) {
      events.push(event.value);
    }
  };

  if (previous.profileName !== next.profileName) {
    await write("name_changed", { from: previous.profileName, to: next.profileName });
  }

  if (previous.pin !== next.pin) {
    /* Only that it moved. Never the digits. */
    await write("pin_changed", { hadPreviousPin: previous.pin !== null });
  }

  if (previous.customerId !== next.customerId) {
    await write(
      "customer_changed",
      { from: previous.customerId, to: next.customerId },
      next.customerId,
    );
  }

  /*
   * The dates travel together as one `extended` event. Three separate entries
   * for a single edit of the same subscription would read as three changes.
   */
  const datesMoved =
    previous.saleDate !== next.saleDate ||
    previous.expirationDate !== next.expirationDate ||
    previous.durationDays !== next.durationDays;

  if (datesMoved) {
    await write("extended", {
      from: {
        saleDate: previous.saleDate,
        expirationDate: previous.expirationDate,
        durationDays: previous.durationDays,
      },
      to: {
        saleDate: next.saleDate,
        expirationDate: next.expirationDate,
        durationDays: next.durationDays,
      },
    });
  }

  return events;
}

async function listForAccount(accountId: string): Promise<Result<readonly ProfileRow[]>> {
  return profilesRepository.listByAccount(accountId);
}

/**
 * Returns a sold profile to stock.
 *
 * The customer keeps their record and their history; the slot keeps its number
 * and its account. What is removed is the allocation joining them — the
 * customer, worker, sale date, expiration and duration on the profile row.
 *
 * Nothing here decides what "sold" means or how a profile is freed. The
 * repository owns both, under one transaction with the row locked, so this
 * function is authorization, translation and the audit trail.
 *
 * Deliberately NOT reusing Quick Replace's release, which frees a profile only
 * as the first half of moving a customer somewhere else and is meaningless
 * without the second.
 */
async function unassignSale(profileId: string, context: AuditContext): Promise<Result<ProfileRow>> {
  const actor = context.actor;

  if (!actor) {
    return fail(new ForbiddenError("No signed-in user for an unassign operation"));
  }

  /*
   * Super Admin only — see PERMISSIONS.UNASSIGN_SALES. Checked here rather than
   * in the action, because the service is the boundary every caller crosses and
   * a second entry point must not be able to skip it.
   */
  if (!roleHasPermission(actor.role, PERMISSIONS.UNASSIGN_SALES)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not unassign a sale`, {
        userMessage: "You do not have permission to remove a sale from a profile.",
      }),
    );
  }

  const released = await profilesRepository.releaseSale(profileId, actor.id);

  if (!released.ok) {
    return released;
  }

  if (released.value.outcome === "not_found") {
    return fail(
      new NotFoundError("Profile not found for unassign", {
        userMessage: "That profile no longer exists.",
      }),
    );
  }

  /*
   * The concurrency answer. Somebody freed it first, or it was never sold —
   * either way the state moved under the operator and saying so is more useful
   * than a generic failure.
   */
  if (released.value.outcome === "not_sold") {
    return fail(
      new ConflictError("Profile is not currently sold", {
        userMessage:
          "This profile is no longer sold — it may have already been updated by someone else.",
      }),
    );
  }

  const { before, after } = released.value;

  /*
   * `before` carries the allocation that was removed, which is the only record
   * of it once the row is cleared. recordOrWarn, like every other mutation
   * here: a failed audit write must not roll back a completed release.
   */
  await auditService.recordOrWarn(
    { entity: "profile", entityId: profileId, action: "update", before, after },
    context,
  );

  return ok(after);
}

export const profilesService = { updateProfile, listForAccount, unassignSale } as const;
