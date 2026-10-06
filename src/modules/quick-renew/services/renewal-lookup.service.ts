import "server-only";

import { remainingDays } from "@/lib/dates";
import type { IssueRow } from "@/lib/drizzle/schema";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  accountCanAllocate,
  accountEffectiveStatus,
  accountRemainingDays,
  profileCellState,
  resolveProfileCustomer,
  toAccountView,
  toProfileView,
  type AccountEffectiveStatus,
  type AccountView,
  type ProfileCellState,
  type ProfileCustomerLink,
  type ProfileView,
} from "@/modules/accounts";
import type { AuditContext } from "@/modules/audit";
import { deriveCustomerStatus, type CustomerStatus } from "@/modules/customers";
import { problemsService } from "@/modules/problems";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { renewalRepository } from "../repositories/renewal.repository";
import { renewLookupSchema, renewQuoteSchema } from "../validation/quick-renew.schema";
import { renewalBlockedReason, type RenewalBlockedReason } from "./renewal-eligibility";
import { quoteRenewal, type RenewalQuote } from "./renewal-duration";
import {
  accountValidityRefusal,
  blockedRenewalMessage,
  requireRenewer,
  toValidationError,
} from "./renewal-guards";

/**
 * Quick Renew, the read-only half. M09 §5, §6, §7 and §16.
 *
 *   preview   find the account by email; show every slot and who holds it
 *   quote     what one renewal would do to one profile's dates
 *
 * Neither writes anything and neither takes a lock, so an operator can look an
 * account up, quote three durations and walk away at no cost. Split from the
 * commit half for the same reason `quick-replace.service.ts` is split from
 * `quick-prepare.service.ts`: releasing or changing anything before a human has
 * approved a plan is how a customer ends up with something nobody intended.
 *
 * The quote is therefore ADVISORY. Stock does not move under a renewal, but the
 * expiry can — somebody else may renew the same profile — which is why the
 * commit re-reads the row under lock and refuses if what it finds no longer
 * matches what was quoted.
 *
 * Every state on these responses is derived HERE, by the same functions the
 * accounts list and Quick Replace use. The browser renders them and computes
 * none of them.
 */

/** One slot on the account, as the operator sees it before choosing. */
export interface RenewableProfile {
  /** The PIN is absent: `ProfileView` drops it, as every browser payload must. */
  readonly profile: ProfileView;
  /** The shared four-state vocabulary — `profileCellState`, never `profiles.status`. */
  readonly state: ProfileCellState;
  readonly customer: ProfileCustomerLink;
  /** Null when nobody holds the slot. */
  readonly customerStatus: CustomerStatus | null;
  /** Whole days left on this allocation. Null when it carries no expiry. */
  readonly remainingDays: number | null;
  readonly hasExpired: boolean;
  /** Why this one cannot be renewed, or null when it can. Server-derived. */
  readonly blockedReason: RenewalBlockedReason | null;
}

/** M09 §5 and §6: the account, its state, and every slot on it. */
export interface RenewalPreview {
  readonly account: AccountView;
  /** What the account IS — the badge's own derivation, so both agree. */
  readonly effectiveStatus: AccountEffectiveStatus;
  /** Days left on the account's own coverage. Null means open-ended. */
  readonly accountRemainingDays: number | null;
  /** Open problems on the account, newest first, as the Problems module ordered them. */
  readonly problems: readonly IssueRow[];
  readonly profiles: readonly RenewableProfile[];
  /**
   * True when the account itself blocks every renewal on it. The UI shows one
   * banner rather than the same refusal five times.
   */
  readonly accountBlocksRenewal: boolean;
}

/** M09 §16: what the operator reviews before confirming. */
export interface RenewalQuoteResult {
  readonly profileId: string;
  readonly profileNumber: number;
  readonly profileName: string | null;
  readonly accountId: string;
  readonly accountEmail: string;
  readonly customer: ProfileCustomerLink;
  readonly quote: RenewalQuote;
  readonly accountRemainingDays: number | null;
}

/* ------------------------------------------------------------------ preview */

/**
 * Step one: find the account by email and show every slot on it.
 *
 * Read-only. No locks, no writes, nothing stranded by an abandoned lookup.
 *
 * Every state on the response is derived HERE, by the same functions the
 * accounts list and Quick Replace use: `profileCellState` for the slot,
 * `accountEffectiveStatus` for the badge, `renewalBlockedReason` for whether
 * renewal is possible. The browser renders them and computes none of them, so
 * there is one interpretation of these rules rather than two that drift.
 */
async function preview(input: unknown, context: AuditContext): Promise<Result<RenewalPreview>> {
  const permitted = requireRenewer(context);

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = renewLookupSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const { accountEmail } = parsed.data;

  const accountResult = await renewalRepository.findAccountByEmail(accountEmail);

  if (!accountResult.ok) {
    return accountResult;
  }

  const account = accountResult.value;

  if (!account) {
    /*
     * A ValidationError carrying a field error, not a NotFoundError: the
     * failure is an address the operator typed and the message has to render ON
     * that input. The same choice Quick Replace made, for the same reason —
     * NotFoundError carries no field errors, so the message would have nowhere
     * to attach and would vanish into a toast.
     */
    return fail(
      new ValidationError(`No live account with email ${accountEmail}`, {
        userMessage: "No account with that email. Check the address and try again.",
        fieldErrors: { accountEmail: "No account found with this email" },
      }),
    );
  }

  const rows = await renewalRepository.listProfilesWithCustomers(account.id);

  if (!rows.ok) {
    return rows;
  }

  /*
   * Problems are read BEFORE the slot states are derived, because the states
   * depend on them: `profileCellState`'s fourth argument defaults to "this
   * account may allocate", and a free slot on a blocked account must read
   * blocked rather than available. Quick Replace learned this the hard way
   * (M01 finding F6) and this flow starts from the fixed version.
   */
  const problemsResult = await problemsService.activeForAccount(account.id);
  const problems = problemsResult.ok ? problemsResult.value : [];

  const now = new Date();
  const canAllocate = accountCanAllocate(account, problems.length > 0, now);

  const profileRows: readonly RenewableProfile[] = rows.value.map((row) => {
    const customer = resolveProfileCustomer(row.profile.customerId, row.customer);
    const days = remainingDays(row.profile.expirationDate, now);

    return {
      profile: toProfileView(row.profile),
      state: profileCellState(row.profile, account, now, canAllocate),
      customer,
      customerStatus: row.customer ? deriveCustomerStatus(row.customer, [], now) : null,
      remainingDays: days,
      hasExpired: days !== null && days < 0,
      blockedReason: renewalBlockedReason(
        {
          account,
          profile: row.profile,
          hasActiveProblem: problems.length > 0,
          customer: row.customer,
        },
        now,
      ),
    };
  });

  return ok({
    account: toAccountView(account),
    effectiveStatus: accountEffectiveStatus(
      account,
      problems.map((problem) => problem.issueType),
      now,
    ),
    accountRemainingDays: accountRemainingDays(account, now),
    problems,
    profiles: profileRows,
    accountBlocksRenewal: !canAllocate,
  });
}

/* -------------------------------------------------------------------- quote */

/**
 * Step two: what one renewal would do. Read-only.
 *
 * Quoted on the server even though the browser could compute it with the same
 * pure function, and that is deliberate: the ACCOUNT VALIDITY check needs the
 * account row, and a quote that passed in the browser and failed at
 * confirmation would be worse than no quote at all — the operator would already
 * have named the new date to the customer.
 */
async function quote(input: unknown, context: AuditContext): Promise<Result<RenewalQuoteResult>> {
  const permitted = requireRenewer(context);

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = renewQuoteSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const { profileId, duration } = parsed.data;

  const read = await renewalRepository.readProfile(profileId);

  if (!read.ok) {
    return read;
  }

  const found = read.value;

  if (!found) {
    return fail(
      new NotFoundError("Profile not found for renewal", {
        userMessage: "That profile no longer exists. Look the account up again.",
      }),
    );
  }

  const now = new Date();

  const blocked = renewalBlockedReason(
    {
      account: found.account,
      profile: found.profile,
      hasActiveProblem: found.hasBlockingProblem,
      customer: found.customer,
    },
    now,
  );

  if (blocked) {
    return fail(
      new ValidationError(`Profile is not renewable: ${blocked}`, {
        userMessage: blockedRenewalMessage(blocked),
      }),
    );
  }

  const computed = quoteRenewal(found.profile, duration, now);

  if (!computed) {
    return fail(
      new ValidationError("Renewal duration produced no usable expiry", {
        userMessage: "That renewal length could not be applied. Choose a different duration.",
        fieldErrors: { days: "Enter a valid number of days" },
      }),
    );
  }

  const fits = accountValidityRefusal(found.account, computed, now);

  if (fits) {
    return fail(fits);
  }

  return ok({
    profileId: found.profile.id,
    profileNumber: found.profile.profileNumber,
    profileName: found.profile.profileName,
    accountId: found.account.id,
    accountEmail: found.account.email,
    customer: resolveProfileCustomer(found.profile.customerId, found.customer),
    quote: computed,
    accountRemainingDays: accountRemainingDays(found.account, now),
  });
}

export const renewalLookupService = { preview, quote } as const;
