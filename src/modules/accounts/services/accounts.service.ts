import "server-only";

import type { AppUser } from "@/lib/auth";
import { PAGINATION } from "@/config/constants";
import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AccountRow, IssueRow, ProfileRow } from "@/lib/drizzle/schema";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { auditService, type AuditContext } from "@/modules/audit";
import { problemsService } from "@/modules/problems";
import type { Page, PaginationInput } from "@/lib/database";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  accountsRepository,
  type AccountFilter,
  type AccountWithCounts,
} from "../repositories/accounts.repository";
import { profilesRepository } from "../repositories/profiles.repository";
import {
  accountInsertSchema,
  accountUpdateSchema,
  changePasswordSchema,
  profileSlotsSchema,
} from "../validation/account.schema";
import { PROFILES_PER_ACCOUNT } from "../validation/profile.schema";
import {
  accountCanAllocate,
  accountRemainingDays,
  canCoverDuration,
  isAccountExpired,
  isProfileFree,
  isSellableSlot,
  profileCellState,
  type ProfileCellState,
} from "./account-validity";
import { resolveProfileCustomer, type ProfileCustomerLink } from "./profile-customer";
import { parseBulkAccounts, type BulkRowError } from "./bulk-accounts.service";
import { deleteEachAccount, uniqueIds, type BulkDeleteReport } from "./bulk-delete";

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

/**
 * Why a profile cannot be allocated.
 *
 * Ordered by how the checks run, which is also least to most specific. M13
 * added three: two account-validity reasons and the sellable-slot one.
 */
export type AllocationBlockedReason =
  | "account_not_healthy"
  | "account_has_problem"
  | "account_expired"
  | "profile_not_for_sale"
  | "profile_not_available"
  | "insufficient_account_validity";

/**
 * How much time the account has, against how much was asked for.
 *
 * Returned on EVERY evaluation, not only on the failing one, so a caller can
 * show remaining validity while things are still fine. The M13 Phase B approval
 * requires both numbers to reach the UI so it can say
 *
 *   Only 18 days remaining. Customer requested 90 days.
 *
 * rather than only naming the blocked reason.
 */
export interface AllocationValidity {
  /** Days left on the account itself. Null means open-ended, never zero. */
  readonly remainingDays: number | null;
  /** What the caller asked for, when it asked for anything. */
  readonly requestedDays: number | null;
}

/** A profile with the account-level rule already applied. */
export interface ProfileAllocation {
  readonly profile: ProfileRow;
  /**
   * Whether this profile may be allocated right now.
   *
   * Never read `profile.status === "available"` on its own. That answer ignores
   * the account, and is the single easiest way to sell a profile on a broken
   * account. Since M13 it is also wrong in the other direction: a profile whose
   * customer has expired still reads `sold` and IS allocatable.
   */
  readonly isAllocatable: boolean;
  /** Why not, when it is not. Null when allocatable. */
  readonly blockedReason: AllocationBlockedReason | null;
  /** Always present, so the UI can explain a rejection with numbers. */
  readonly validity: AllocationValidity;
  /**
   * The slot's visual state, from `profileCellState`.
   *
   * Carried here so the profile cards read the same derivation as the
   * indicator strip above them. The card used to badge `profile.status`
   * directly, which is why a slot could show a green "Sold" beside a yellow
   * chip for the same profile.
   */
  readonly state: ProfileCellState;
}

/**
 * A profile allocation that also names who holds the slot.
 *
 * Separate from `ProfileAllocation` on purpose. That type is what the Smart
 * Stock Engine and Quick Prepare consume to decide whether a slot can be sold,
 * and the answer to that question does not depend on the customer's identity —
 * loading one for them would be a join they never read. The screens that draw a
 * profile card need the name; the engines that allocate do not.
 */
export interface ProfileAllocationWithCustomer extends ProfileAllocation {
  /**
   * Always present, never undefined, and never a bare null.
   *
   * The union's three cases are the three things a card can say, so a screen
   * cannot accidentally render an empty field by forgetting a branch.
   */
  readonly customer: ProfileCustomerLink;
}

/** Everything `evaluateAllocation` needs beyond the two rows themselves. */
export interface AllocationContext {
  /** From problemsService. An open problem blocks every profile on the account. */
  readonly hasActiveProblem?: boolean | undefined;
  /**
   * The subscription length being asked for, when there is one.
   *
   * Omitted by screens that are only describing current state, such as the
   * account detail page — those have no duration in hand and must not be told
   * a profile is blocked for failing a check nobody made.
   */
  readonly requestedDurationDays?: number | undefined;
  /** Injected so the rule is testable without mocking a clock. */
  readonly today?: Date | undefined;
}

export interface AccountDetail {
  /**
   * Without the credential.
   *
   * The detail page passes this straight into `AccountHeader`, which is a Client
   * Component — so the full row would have put the AES ciphertext into the RSC
   * payload on every account view. The plaintext was never here (ADR-006 D4),
   * but the ciphertext was, and it did not need to be.
   */
  readonly account: AccountView;
  readonly profiles: readonly ProfileAllocationWithCustomer[];
  /** Per-profile display state, from the same rule the accounts list uses. */
  readonly indicators: readonly ProfileIndicator[];
  /** Open problems blocking this account. Empty when nothing is wrong. */
  readonly activeProblems: readonly IssueRow[];
  /**
   * False when the account's status, an open problem, or its own expiry blocks
   * every profile.
   */
  readonly accountAllowsAllocation: boolean;
  /** Days left on the account's own coverage. Null means open-ended. */
  readonly remainingValidityDays: number | null;
  /** True when the profile count is not exactly five. Signals corrupt data. */
  readonly hasProfileCountAnomaly: boolean;
}

/**
 * Applies the unhealthy-account rule.
 *
 * Exported so the Smart Stock Engine and Quick Prepare use the same function
 * rather than reimplementing the rule. One definition, one place to be wrong.
 *
 * M08 added the second input. `accounts.status` remains the persisted
 * operational status and problems never write to it — ADR-010 Decision 4. An
 * account is allocatable only when its status is healthy AND no active blocking
 * problem exists, and that conjunction is computed here rather than stored, so
 * neither fact is duplicated and neither can go stale against the other.
 */
export function evaluateAllocation(
  account: AccountRow,
  profile: ProfileRow,
  context: AllocationContext = {},
): ProfileAllocation {
  const today = context.today ?? new Date();
  const requestedDays = context.requestedDurationDays ?? null;

  const validity: AllocationValidity = {
    remainingDays: accountRemainingDays(account, today),
    requestedDays,
  };

  /*
   * One derivation for the badge, computed before the branches so every exit
   * carries it — including the blocked ones, where the slot still has a
   * colour and a customer may still be holding it.
   */
  const state = profileCellState(
    profile,
    account,
    today,
    accountCanAllocate(account, context.hasActiveProblem === true, today),
  );

  const blocked = (reason: AllocationBlockedReason): ProfileAllocation => ({
    profile,
    isAllocatable: false,
    blockedReason: reason,
    validity,
    state,
  });

  if (account.status !== "healthy") {
    return blocked("account_not_healthy");
  }

  /*
   * Checked after status so the more specific reason wins: an account that is
   * both unhealthy and has an open problem reports the status, which is what a
   * worker can act on directly.
   */
  if (context.hasActiveProblem === true) {
    return blocked("account_has_problem");
  }

  /*
   * The account's own coverage, before anything about this particular profile.
   * An expired account cannot serve anyone, so the reason should name the
   * account rather than sending a worker to look at the profile.
   */
  if (isAccountExpired(account, today)) {
    return blocked("account_expired");
  }

  /*
   * M13: a slot above accounts.profile_slots is not stock and never becomes
   * stock. Distinct from "not available", because there is nothing to wait for
   * — no expiry will free it and no release will return it.
   */
  if (!isSellableSlot(profile, account)) {
    return blocked("profile_not_for_sale");
  }

  /*
   * Occupancy, derived. `available` is free; so is a profile whose customer's
   * time has run out — 03_DATABASE.md: "Expired Profile → Automatically
   * Available if account is Healthy." Reading profile.status alone would keep a
   * long-expired allocation off the market forever, which is what it did until
   * M13.
   */
  if (!isProfileFree(profile, today)) {
    return blocked("profile_not_available");
  }

  /*
   * Last, because it is the only check that depends on what the caller wants
   * rather than on what is true. Skipped entirely when no duration was supplied
   * — a screen describing current state must not be told a healthy free profile
   * is blocked.
   */
  if (requestedDays !== null && !canCoverDuration(account, requestedDays, today)) {
    return blocked("insufficient_account_validity");
  }

  return { profile, isAllocatable: true, blockedReason: null, validity, state };
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
/**
 * Whether the actor may change an account record.
 *
 * EDIT_ACCOUNTS exists in the permission matrix and is deliberately withheld
 * from Workers, but nothing checked it: `updateAccount` validated, wrote and
 * audited without ever asking who was calling. A Worker could therefore edit
 * any account through the Server Action, which is a POST endpoint and does not
 * care that the Edit button is on screen.
 *
 * Added because the account note is written through `updateAccount`, and a note
 * that anyone can change is not the "existing account-management permissions"
 * this feature was asked to follow.
 */
function assertMayEdit(actor: AppUser | null): Result<AppUser> {
  if (!actor) {
    return fail(new ForbiddenError("No signed-in user for an account edit"));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.EDIT_ACCOUNTS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not edit accounts`, {
        userMessage: "You do not have permission to edit accounts.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  return ok(actor);
}

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

/** One profile indicator on the accounts list. Carries no secret. */
export interface ProfileIndicator {
  readonly profileId: string;
  readonly profileNumber: number;
  readonly state: ProfileCellState;
  /** For the tooltip. Null when the profile has never been sold. */
  readonly expirationDate: string | null;
}

/**
 * An account as a browser may see it: everything except the credential.
 *
 * `passwordEncrypted` is removed at the service boundary rather than trusted to
 * every component that renders a list. It is ciphertext, not plaintext, so this
 * is not a plaintext leak — but a page listing twenty-five accounts would have
 * shipped twenty-five AES blobs into the RSC payload, where they sit in the HTML
 * source, in the browser cache and in any DevTools session. Offline material an
 * attacker does not need to be given.
 */
export type AccountView = Omit<AccountRow, "passwordEncrypted">;

/**
 * Drops the credential. The one place an account crosses to a browser.
 *
 * Exported so Quick Replace's preview projects through the same function rather
 * than writing a second one. A duplicated projection is a projection that can
 * fall behind when a credential column is added.
 */
export function toAccountView(account: AccountRow): AccountView {
  const { passwordEncrypted: _password, ...view } = account;
  return view;
}

/**
 * A profile as a browser may see it: everything except the PIN.
 *
 * The profile-shaped counterpart to `AccountView`, and it exists for the same
 * reason. A PIN is a credential the customer receives once, at handover, from
 * the Quick Prepare result screen. Nothing that merely *describes* stock — a
 * list, an indicator, a replacement preview — has any reason to carry one, and a
 * payload that never contains it cannot leak it.
 *
 * `AccountListRow` already solves this by dropping profile rows entirely. Views
 * that must show individual slots need the row minus the credential instead.
 */
export type ProfileView = Omit<ProfileRow, "pin">;

/** Drops the PIN. Mirrors `toAccountView`. */
export function toProfileView(profile: ProfileRow): ProfileView {
  const { pin: _pin, ...view } = profile;
  return view;
}

/**
 * An account list row, with its five indicators already derived.
 *
 * Deliberately does NOT carry the raw profile rows. They hold PINs and customer
 * ids that the list never displays, and the safest way to keep them out of the
 * payload is to never put them in it. The component gets `indicators`, which
 * carry a profile number, a state and a date.
 */
export interface AccountListRow extends Omit<AccountWithCounts, "account" | "profiles"> {
  readonly account: AccountView;
  readonly indicators: readonly ProfileIndicator[];
  /** Days left on the account's own coverage. Null means open-ended. */
  readonly remainingValidityDays: number | null;
  /**
   * At least one problem in a blocking status is open against this account.
   *
   * Carried on the row because `accounts.status` cannot express it — ADR-010
   * Decision 4 keeps problems out of that column — and the list has to show the
   * same state the detail page and Quick Prepare show. M13 §7.
   */
  readonly hasActiveProblem: boolean;
  /**
   * The types of those blocking problems, so the badge can say "Payment
   * Problem" rather than a bare "Problem". Empty when `hasActiveProblem` is
   * false. From the same single query as the flag.
   */
  readonly activeProblemTypes: readonly IssueRow["issueType"][];
  /**
   * The account's five profiles, evaluated exactly as the detail page
   * evaluates them.
   *
   * Built from profile rows `listWithCounts` ALREADY loads — one batched
   * `inArray` for the whole page — so carrying them costs no extra query. The
   * list used to derive `indicators` from these rows and then discard them.
   *
   * PAYLOAD NOTE: this widens what the list sends. `indicators` carried only a
   * number, a state and a date; a ProfileAllocation carries the whole profile
   * row, including its PIN and customer id. That is the same data the account
   * detail page has always sent for one account, now sent for a page of them,
   * and it is what the inline profiles panel renders. The account password is
   * still never here: `toAccountView` drops it before this point.
   *
   * The customer travels with each slot too, resolved from that profile's own
   * customer_id through the join the same query makes. Five slots on one
   * account can name five different customers, and none of them is the
   * account's customer, because an account does not have one.
   */
  readonly profiles: readonly ProfileAllocationWithCustomer[];
}

/**
 * The accounts list.
 *
 * Derives every profile indicator HERE rather than in the table component.
 *
 * M13 §7 requires the list, the detail page and Quick Prepare to show the same
 * state, and the only way to guarantee that is for one function to decide it.
 * `profileCellState` is that function; the component receives four literal
 * strings and renders colours.
 *
 * It also keeps the client honest by omission: the payload carries no password,
 * no PIN and no customer identity, so a component cannot leak what it was never
 * given.
 */
async function listAccounts(filter: AccountFilter): Promise<Result<Page<AccountListRow>>> {
  const page = await accountsRepository.listWithCounts(filter);

  if (!page.ok) {
    return page;
  }

  /* One clock for the whole page, so two rows cannot straddle midnight. */
  const today = new Date();

  /*
   * One query for the whole page, not one per row.
   *
   * The list used to ask nothing about problems, so every account rendered its
   * persisted `accounts.status` and an account with an open payment problem
   * showed a green "Healthy" badge. `getAccountDetail` had always asked — this
   * is the list catching up with it, through the same public API, so there is
   * still exactly one definition of "active".
   *
   * A failure here must not blank the accounts list: problems are supplementary
   * to it. An empty set degrades to today's behaviour rather than an error page.
   */
  const flagged = await problemsService.accountsWithActiveProblems(
    page.value.items.map((row) => row.account.id),
  );
  const withProblems: ReadonlyMap<string, readonly IssueRow["issueType"][]> = flagged.ok
    ? flagged.value
    : new Map();

  return ok({
    ...page.value,
    items: page.value.items.map((row) => {
      /* Both dropped on purpose — see AccountView and AccountListRow. */
      const { profiles: rawProfiles, ...rest } = row;

      const rowHasProblem = withProblems.has(row.account.id);
      const canAllocate = accountCanAllocate(row.account, rowHasProblem, today);

      return {
        ...rest,
        account: toAccountView(row.account),
        hasActiveProblem: rowHasProblem,
        activeProblemTypes: withProblems.get(row.account.id) ?? [],
        /*
         * The same call the detail page makes, so a slot cannot read one way in
         * the inline panel and another after clicking through. Sorted by number
         * because the panel renders "Profile 1..5" and the query does not
         * promise an order.
         */
        profiles: [...rawProfiles]
          .sort((a, b) => a.profile.profileNumber - b.profile.profileNumber)
          .map(({ profile, customer }) => ({
            ...evaluateAllocation(row.account, profile, {
              hasActiveProblem: rowHasProblem,
              today,
            }),
            /*
             * From this profile's own customer_id and the row the join returned
             * for it — never from the account, and never from a neighbouring
             * slot. Five profiles on one account resolve five times.
             */
            customer: resolveProfileCustomer(profile.customerId, customer),
          })),
        remainingValidityDays: accountRemainingDays(row.account, today),
        indicators: rawProfiles.map(({ profile }) => ({
          profileId: profile.id,
          profileNumber: profile.profileNumber,
          state: profileCellState(profile, row.account, today, canAllocate),
          expirationDate: profile.expirationDate,
        })),
      };
    }),
  });
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

  /*
   * Active problems reach this module through the Problems module's public API,
   * never by querying `issues` here. The M08 brief makes ProblemsService the
   * single source of truth for problems, and a second reader would be a second
   * definition of "active".
   */
  const activeProblems = await problemsService.activeForAccount(id);
  const problems = activeProblems.ok ? activeProblems.value : [];
  const hasActiveProblem = problems.length > 0;

  /* One clock for the whole page, so five profiles cannot straddle midnight. */
  const today = new Date();

  return ok({
    account: toAccountView(account),
    activeProblems: problems,
    /*
     * Same function as the accounts list, so the cells on this page and the
     * cells on that one can never tell different stories. M13 §7.
     */
    indicators: profilesResult.value.map(({ profile }) => ({
      profileId: profile.id,
      profileNumber: profile.profileNumber,
      state: profileCellState(
        profile,
        account,
        today,
        accountCanAllocate(account, hasActiveProblem, today),
      ),
      expirationDate: profile.expirationDate,
    })),
    profiles: profilesResult.value.map(({ profile, customer }) => ({
      /*
       * No requestedDurationDays: this screen describes what is true, it is not
       * asking to allocate anything. Supplying one would mark free profiles
       * blocked against a duration nobody entered.
       */
      ...evaluateAllocation(account, profile, { hasActiveProblem, today }),
      /* Same resolver as the list, so both screens name one customer. */
      customer: resolveProfileCustomer(profile.customerId, customer),
    })),
    /*
     * The shared rule, not a restatement of it. This used to spell out three of
     * accountCanAllocate's four conditions inline and left out `deletedAt`, so
     * the banner and the cards below it were judged by different rules.
     */
    accountAllowsAllocation: accountCanAllocate(account, hasActiveProblem, today),
    remainingValidityDays: accountRemainingDays(account, today),
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

/** What a bulk import did, row by row. Every submitted row appears in exactly one list. */
export interface BulkCreateResult {
  /**
   * `AccountView`, not `AccountRow`.
   *
   * This value is returned through a Server Action, so it is serialized to the
   * browser in full. Returning the raw rows shipped the AES ciphertext of every
   * freshly created account to the client at once — the same leak already fixed
   * on the accounts list and the detail page, and the worst of the three
   * because a bulk import creates many at a time.
   */
  readonly created: readonly AccountView[];
  readonly rejected: readonly BulkRowError[];
  /** Submitted rows, so a UI can assert created + rejected accounts for all of them. */
  readonly submitted: number;
  /** What the parser assumed, so the UI can say "read as tab-separated". */
  readonly delimiter: string;
  readonly headerDropped: boolean;
}

/**
 * Creates many accounts from pasted text.
 *
 * Partial success with a complete report. An earlier draft refused the entire
 * batch if any row failed; that was wrong for the actual job. An operator
 * importing a hundred accounts should not lose ninety-nine because one row has
 * a typo, and asking them to re-paste a corrected list is worse than it sounds
 * — the rows that already imported would come back as duplicate errors.
 *
 * The safety the brief actually asks for is "no SILENT partial creation", and
 * that is what this guarantees:
 *
 *   1. Every row is validated first, against the same schema a single creation
 *      uses. There is no laxer import path.
 *   2. Valid rows are written under ONE transaction, so a crash cannot leave an
 *      account without its five profiles.
 *   3. An email already taken skips that row — decided by the unique index, not
 *      by a prior SELECT, so two operators importing overlapping lists cannot
 *      race.
 *   4. EVERY submitted row comes back either created or rejected with a reason
 *      and a line number. `submitted` is the arithmetic check on that claim.
 */
async function createAccountsInBulk(
  input: unknown,
  context: AuditContext,
): Promise<Result<BulkCreateResult>> {
  if (typeof input !== "string" || input.trim() === "") {
    return fail(
      new ValidationError("Bulk import received no text", {
        userMessage: "Paste at least one account first.",
        fieldErrors: { rows: "Paste at least one row" },
      }),
    );
  }

  const parsed = parseBulkAccounts(input);
  const submitted = parsed.valid.length + parsed.errors.length;

  if (submitted === 0) {
    return fail(
      new ValidationError("Bulk import found no rows", {
        userMessage: "No rows were found in that text.",
        fieldErrors: { rows: "No rows were found" },
      }),
    );
  }

  /* Rows that failed parsing or validation. Carried through, not fatal. */
  const rejected: BulkRowError[] = [...parsed.errors];

  if (parsed.errors.length > 0) {
    logger.warn("Bulk account import had invalid rows", {
      submitted,
      rejected: parsed.errors.length,
      /* Line numbers and field names only. Never a cell value. */
      lines: parsed.errors.map((error) => error.line),
    });
  }

  let created: readonly AccountView[] = [];

  if (parsed.valid.length > 0) {
    const write = await accountsRepository.createMany(parsed.valid, context.actor?.id ?? null);

    if (!write.ok) {
      return write;
    }

    /*
     * Mapped, not merely re-typed. `AccountRow` is structurally assignable to
     * `AccountView` — extra properties are permitted — so narrowing the type
     * alone would compile cleanly while the ciphertext stayed in the object at
     * runtime. The type would have been lying. This actually removes it.
     */
    created = write.value.created.map(toAccountView);

    /*
     * Emails the database refused because they already exist. Reported against
     * the line the operator actually typed, which is why parseBulkAccounts
     * tracks line numbers rather than array indices.
     */
    for (const email of write.value.skippedEmails) {
      rejected.push({
        line: parsed.lineForEmail(email) ?? 0,
        email,
        fieldErrors: { email: "An account with this email already exists" },
        message: "Skipped — this email is already registered",
      });
    }
  }

  /* One audit entry per account, matching what a single creation records. */
  for (const account of created) {
    await auditService.recordOrWarn(
      {
        entity: "account",
        entityId: account.id,
        action: "create",
        after: { ...account, importedInBulk: true },
      },
      context,
    );
  }

  return ok({
    created,
    /*
     * By line, so the operator reads them in the order they typed them. Parse
     * failures are collected first and database rejections appended, which
     * otherwise lists line 3 above line 2 for no reason a reader can see.
     */
    rejected: [...rejected].sort((left, right) => left.line - right.line),
    submitted,
    delimiter: parsed.delimiter,
    headerDropped: parsed.headerDropped,
  });
}

/**
 * Changes how many of the five profile rows are sellable.
 *
 * A dedicated method rather than a field on updateAccount, for three reasons
 * the generic path cannot satisfy:
 *
 *   1. The profile rows must move with it. Raising the count returns rows to
 *      `available`; lowering it marks them `not_for_sale`. Both happen in the
 *      same transaction as the column change, so the two can never disagree.
 *
 *   2. Lowering below an occupied slot must be refused. Somebody has paid for
 *      that profile; taking it out of stock would either strand them or force
 *      an un-sale, and neither is a thing an inventory setting should do
 *      silently.
 *
 *   3. The M13 Phase B approval requires this specific change to be audited
 *      with the old and new value, by name.
 */
async function setProfileSlots(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<AccountRow>> {
  const parsed = profileSlotsSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues, "Profile slots failed validation"));
  }

  const before = await accountsRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  const previousSlots = before.value.profileSlots;
  const nextSlots = parsed.data.profileSlots;

  if (previousSlots === nextSlots) {
    /* Nothing moved. Writing an audit entry for a no-op would be noise. */
    return ok(before.value);
  }

  const updated = await accountsRepository.setProfileSlots(id, nextSlots);

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: id,
      action: "update",
      /*
       * Named explicitly rather than left to a whole-row diff. The approval
       * asks who changed it, when, from what, to what — actor and timestamp
       * come from the audit context, these two are the payload.
       */
      before: { profileSlots: previousSlots },
      after: { event: "profile_slots_changed", profileSlots: nextSlots },
    },
    context,
  );

  return updated;
}

/**
 * Replaces the stored Netflix password.
 *
 * Separate from updateAccount because M13 §8 needs it to be: the Quick Prepare
 * reuse flow asks an operator to change a reused account's password and record
 * that they did, and that is a different operation from editing an account's
 * details. It gets its own confirmation rules and its own audit event.
 *
 * The CRM does not and cannot change the password AT Netflix. This records the
 * new value so the next customer receives the right one, and nothing more.
 *
 * The plaintext reaches lib/crypto and the repository. It is never logged,
 * never placed in the audit payload, and never returned.
 */
async function changePassword(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<AccountRow>> {
  const parsed = changePasswordSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues, "Password change failed validation"));
  }

  const before = await accountsRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  /* The same encryption path as creation. There is no second one. */
  const updated = await accountsRepository.update(id, { password: parsed.data.newPassword });

  if (!updated.ok) {
    return updated;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: id,
      action: "update",
      /* The event, never the value — not the old one and not the new one. */
      after: { event: "password_changed", confirmedByOperator: true },
    },
    context,
  );

  return updated;
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
  const permitted = assertMayEdit(context.actor);

  if (!permitted.ok) {
    return permitted;
  }

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
 * Maximum accounts one bulk delete may touch.
 *
 * A page holds 25 and selection cannot reach past the page, so this is not a
 * limit an operator can meet through the UI. It exists because a Server Action
 * is a POST endpoint anyone signed in can call directly with a hand-written
 * array, and an unbounded loop of writes is worth refusing.
 */
const MAX_BULK_DELETE = PAGINATION.MAX_PAGE_SIZE;

/**
 * Soft-deletes several accounts.
 *
 * Not a second deletion mechanism: every account goes through
 * `softDeleteAccount` above, so the permission check, the soft delete and the
 * audit entry are the same ones a single delete performs. This function adds
 * only the things a batch needs — validating the list, refusing an unauthorized
 * caller once rather than `n` times, and reporting which accounts failed.
 *
 * Partial success is reported rather than rolled back. See `deleteEachAccount`.
 */
async function softDeleteAccounts(
  ids: unknown,
  context: AuditContext,
): Promise<Result<BulkDeleteReport>> {
  /*
   * Authorization first, before the input is even inspected. A caller who may
   * not delete accounts learns nothing about which ids exist.
   *
   * Checking here does not replace the check inside softDeleteAccount — that
   * one still runs for every account. This one exists so a Worker gets a single
   * clear refusal instead of a report listing every account as failed.
   */
  const permitted = assertMayDelete(context.actor);

  if (!permitted.ok) {
    return permitted;
  }

  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return fail(
      new ValidationError("Bulk delete received something other than a list of ids", {
        userMessage: "Select at least one account first.",
      }),
    );
  }

  const requested = uniqueIds(ids as string[]);

  if (requested.length === 0) {
    return fail(
      new ValidationError("Bulk delete received no ids", {
        userMessage: "Select at least one account first.",
      }),
    );
  }

  if (requested.length > MAX_BULK_DELETE) {
    return fail(
      new ValidationError(`Bulk delete received ${requested.length} ids`, {
        userMessage: `You can delete at most ${MAX_BULK_DELETE} accounts at a time.`,
      }),
    );
  }

  const report = await deleteEachAccount(requested, (id) => softDeleteAccount(id, context));

  if (report.failed.length > 0) {
    logger.warn("Bulk account delete completed with failures", {
      requested: requested.length,
      deleted: report.deleted.length,
      failed: report.failed.length,
    });
  }

  return ok(report);
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

/**
 * Converts Zod issues into a ValidationError carrying field-level messages.
 *
 * Also LOGS them, and that is not incidental.
 *
 * Account creation was broken from the day it was written: the schema demanded
 * a defaulted column no form collects. The field error had no input to attach
 * to, so it rendered nowhere and the screen showed only "Could not create
 * account" — a generic message hiding a precise, fixable cause. Nothing on the
 * server said anything at all.
 *
 * A rejected input is not an application error, so this logs at warn: it is the
 * caller's data that was wrong. But it must leave a trace naming the fields,
 * because a validation failure the user cannot see and the server does not
 * record is undiagnosable from either side.
 *
 * Field NAMES and messages only — never the submitted values. An account
 * payload carries a plaintext Netflix password.
 */
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

  logger.warn("Account input rejected by validation", {
    message,
    fields: Object.keys(fieldErrors),
    issues: issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });

  return new ValidationError(message, { fieldErrors });
}

export const accountsService = {
  listAccounts,
  getAccountDetail,
  createAccount,
  createAccountsInBulk,
  setProfileSlots,
  changePassword,
  updateAccount,
  archiveAccount,
  restoreAccount,
  softDeleteAccount,
  softDeleteAccounts,
  revealPassword,
  getAccountTimeline,
} as const;
