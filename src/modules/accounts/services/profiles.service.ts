import "server-only";

import type { ProfileEventRow, ProfileRow } from "@/lib/drizzle/schema";
import { ValidationError } from "@/lib/errors";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { profilesRepository } from "../repositories/profiles.repository";
import { profileEditSchema } from "../validation/profile.schema";

/**
 * Profiles service.
 *
 * M03 permits editing only the profile name and the PIN. It explicitly forbids
 * changing the profile number, creating profiles and deleting profiles — so
 * this file contains no method that could do any of those, and neither does the
 * repository.
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

/**
 * Updates a profile's name and PIN.
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

  const before = await profilesRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const previous = before.value;
  const changes = parsed.data;

  const nameChanged =
    changes.profileName !== undefined && changes.profileName !== previous.profileName;
  const pinChanged = changes.pin !== undefined && changes.pin !== previous.pin;

  if (!nameChanged && !pinChanged) {
    /*
     * Nothing to do. Returning success with no event is better than writing a
     * history entry that records no change — a timeline full of empty edits is
     * worse than no timeline.
     */
    return ok({ profile: previous, events: [] });
  }

  const updated = await profilesRepository.update(id, changes);

  if (!updated.ok) {
    return updated;
  }

  const events: ProfileEventRow[] = [];

  if (nameChanged) {
    const event = await profilesRepository.recordEvent({
      accountId: previous.accountId,
      profileId: id,
      eventType: "name_changed",
      userId: context.actor?.id ?? null,
      metadata: { from: previous.profileName, to: changes.profileName },
    });

    if (event.ok) {
      events.push(event.value);
    }
  }

  if (pinChanged) {
    const event = await profilesRepository.recordEvent({
      accountId: previous.accountId,
      profileId: id,
      /* No PIN values in metadata — only that it moved. */
      eventType: "pin_changed",
      userId: context.actor?.id ?? null,
      metadata: { hadPreviousPin: previous.pin !== null },
    });

    if (event.ok) {
      events.push(event.value);
    }
  }

  await auditService.recordOrWarn(
    {
      entity: "profile",
      entityId: id,
      action: "update",
      before: previous,
      after: updated.value,
    },
    context,
  );

  return ok({ profile: updated.value, events });
}

async function listForAccount(accountId: string): Promise<Result<readonly ProfileRow[]>> {
  return profilesRepository.listByAccount(accountId);
}

export const profilesService = { updateProfile, listForAccount } as const;
