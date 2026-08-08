import "server-only";

import type { CustomerRow } from "@/lib/drizzle/schema";
import { ConflictError } from "@/lib/errors";
import { normalizePhone } from "@/lib/phone";
import type { Result } from "@/types/result";
import { ok } from "@/utils/result";
import { customersRepository } from "../repositories/customers.repository";

/**
 * Customers service.
 *
 * ADR-007 Decision 3: one capability only — find-or-create by normalized phone.
 * Quick Prepare needs a customer to attach to the profiles it allocates; full
 * Customer Management is a later milestone.
 *
 * 01_MASTER_RULES.md defines customer identity as the normalized WhatsApp
 * number, and the Phone Engine is the only thing permitted to produce it.
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

export const customersService = { findOrCreateByPhone } as const;
