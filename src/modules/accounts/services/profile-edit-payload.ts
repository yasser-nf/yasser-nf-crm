/**
 * What the profile editor submits.
 *
 * Pure and free of `server-only`, so the rule can be tested without rendering
 * the dialog. Every field is prefilled from the stored profile, so "non-empty"
 * no longer means "the operator wants this changed" — sending the prefilled
 * sale date and duration on every save made the service treat a note edit as
 * an allocation change and run the allocation checks against it.
 *
 * So a field is sent only when it differs from what the form opened with:
 *
 *   profileName, pin, saleDate, durationDays, customerPhone
 *        sent when changed and non-empty. Blank means "leave it alone"; none of
 *        these can be cleared from here (a sale is removed with Unassign, a
 *        customer moved with Quick Replace).
 *   notes
 *        sent whenever it changed, INCLUDING to empty — that is how a note is
 *        cleared. The service stores an empty note as null.
 *   expirationDate
 *        never. The service derives it from sale date + duration.
 */

export interface ProfileEditFormValues {
  readonly profileName?: string | undefined;
  readonly pin?: string | undefined;
  readonly notes?: string | undefined;
  readonly customerPhone?: string | undefined;
  readonly saleDate?: string | undefined;
  readonly expirationDate?: string | undefined;
  readonly durationDays?: string | undefined;
}

export function buildProfileEditPayload(
  values: ProfileEditFormValues,
  initial: ProfileEditFormValues,
  canAllocate: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  const changed = (field: keyof ProfileEditFormValues): boolean =>
    (values[field] ?? "").trim() !== (initial[field] ?? "").trim();

  const setIfChangedAndFilled = (field: keyof ProfileEditFormValues) => {
    const value = values[field]?.trim();

    if (value && changed(field)) {
      payload[field] = value;
    }
  };

  setIfChangedAndFilled("profileName");
  setIfChangedAndFilled("pin");

  if (changed("notes")) {
    payload["notes"] = (values.notes ?? "").trim();
  }

  if (canAllocate) {
    setIfChangedAndFilled("customerPhone");
    setIfChangedAndFilled("saleDate");

    const duration = values.durationDays?.trim();

    if (duration && changed("durationDays")) {
      payload["durationDays"] = Number(duration);
    }
  }

  return payload;
}
