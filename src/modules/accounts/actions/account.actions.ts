"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { ROUTES } from "@/config/constants";
import { getCurrentUser } from "@/lib/auth/session";
import { UnauthorizedError, isAppError, type AppError } from "@/lib/errors";
import type { AuditContext } from "@/modules/audit";
import { bulkProblemsService } from "@/modules/problems";
import type { AccountFilter } from "../repositories/accounts.repository";
import { accountExportService } from "../services/account-export.service";
import { accountsService } from "../services/accounts.service";
import { previewBulkAccounts } from "../services/bulk-accounts.service";
import { profilesService } from "../services/profiles.service";

/**
 * Account server actions.
 *
 * ADR-006 Decision 3: this is the network boundary. An action validates that
 * someone is signed in, builds the audit context, calls exactly one service
 * method, and returns. It contains no business logic.
 *
 * Every action returns a serialisable envelope rather than a Result. A Result
 * carries an AppError instance, and class instances do not survive the
 * server-to-client boundary — the prototype and its methods are lost, so
 * `error.userMessage` would be undefined by the time a component read it.
 */

/** Serialisable outcome. The client-side shape of a Result. */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly message: string;
      readonly code: string;
      readonly fieldErrors?: Record<string, string>;
    };

function toFailure(error: AppError): ActionResult<never> {
  const fieldErrors =
    "fieldErrors" in error && error.fieldErrors ? { ...error.fieldErrors } : undefined;

  return {
    ok: false,
    /* Only userMessage crosses the boundary. Never the technical message. */
    message: error.userMessage,
    code: error.code,
    ...(fieldErrors ? { fieldErrors } : {}),
  };
}

/**
 * Resolves the caller and request metadata.
 *
 * Middleware already rejects unauthenticated requests, but a Server Action is a
 * POST endpoint that can be invoked directly. 02_ARCHITECTURE.md requires
 * validating twice, so the session is checked again rather than assumed.
 */
async function requireContext(): Promise<AuditContext | null> {
  const actor = await getCurrentUser();

  if (!actor) {
    return null;
  }

  const headerList = await headers();

  return {
    actor,
    ipAddress: headerList.get("x-forwarded-for") ?? undefined,
    userAgent: headerList.get("user-agent") ?? undefined,
  };
}

type ServiceOutcome<T> = { ok: true; value: T } | { ok: false; error: AppError };

/** Wraps an action body with authentication, error mapping and revalidation. */
async function run<T>(
  operation: (context: AuditContext) => Promise<ServiceOutcome<T>>,
  revalidate: readonly string[] = [],
): Promise<ActionResult<T>> {
  const context = await requireContext();

  if (!context) {
    return toFailure(new UnauthorizedError("Server action called without a session"));
  }

  try {
    const result = await operation(context);

    if (!result.ok) {
      return toFailure(result.error);
    }

    for (const path of revalidate) {
      revalidatePath(path);
    }

    return { ok: true, data: result.value };
  } catch (caught) {
    /*
     * A service returns a Result rather than throwing, but an action is the
     * outermost boundary and must not leak a stack trace to the browser if one
     * ever does.
     */
    return isAppError(caught)
      ? toFailure(caught)
      : { ok: false, message: "Something went wrong. Please try again.", code: "UNEXPECTED_ERROR" };
  }
}

export async function createAccountAction(input: unknown) {
  return run(async (context) => accountsService.createAccount(input, context), [ROUTES.ACCOUNTS]);
}

/**
 * Creates many accounts from pasted text.
 *
 * The text arrives as an opaque string and is parsed server-side. Parsing in
 * the browser and posting a structured array would make the client's parser the
 * authority on where a password ends, which is not a decision that belongs
 * there — and it would let a crafted payload skip the row validation entirely.
 */
export async function createAccountsInBulkAction(input: unknown) {
  return run(
    async (context) => accountsService.createAccountsInBulk(input, context),
    [ROUTES.ACCOUNTS],
  );
}

/**
 * Parses pasted text for the bulk preview. Writes nothing.
 *
 * Runs the parser on the SERVER rather than shipping it to the browser, so the
 * rows an operator approves are the rows the submit step will validate. A
 * client-side copy could disagree about quoting or delimiter detection, and the
 * operator would have approved something other than what was imported.
 *
 * The returned rows carry no password — see `BulkPreviewRow`.
 */
export async function previewBulkAccountsAction(input: unknown) {
  return run(async () => {
    if (typeof input !== "string") {
      return { ok: true as const, value: previewBulkAccounts("") };
    }

    return { ok: true as const, value: previewBulkAccounts(input) };
  });
}

/** Changes how many of the five profiles an account sells. Audited by the service. */
export async function setProfileSlotsAction(id: string, input: unknown) {
  return run(
    async (context) => accountsService.setProfileSlots(id, input, context),
    [ROUTES.ACCOUNTS, `${ROUTES.ACCOUNTS}/${id}`],
  );
}

/**
 * Replaces the stored Netflix password.
 *
 * The plaintext travels in the POST body, never in the URL or a query string —
 * a Server Action is a POST by construction, which is part of why M13 §4 and §8
 * can be satisfied without inventing a new transport.
 */
export async function changeAccountPasswordAction(id: string, input: unknown) {
  return run(
    async (context) => accountsService.changePassword(id, input, context),
    [`${ROUTES.ACCOUNTS}/${id}`],
  );
}

export async function updateAccountAction(id: string, input: unknown) {
  return run(
    async (context) => accountsService.updateAccount(id, input, context),
    [ROUTES.ACCOUNTS, `${ROUTES.ACCOUNTS}/${id}`],
  );
}

export async function archiveAccountAction(id: string) {
  return run(
    async (context) => accountsService.archiveAccount(id, context),
    [ROUTES.ACCOUNTS, `${ROUTES.ACCOUNTS}/${id}`],
  );
}

export async function restoreAccountAction(id: string) {
  return run(
    async (context) => accountsService.restoreAccount(id, context),
    [ROUTES.ACCOUNTS, `${ROUTES.ACCOUNTS}/${id}`],
  );
}

export async function deleteAccountAction(id: string) {
  return run(async (context) => accountsService.softDeleteAccount(id, context), [ROUTES.ACCOUNTS]);
}

/**
 * Soft-deletes the accounts selected in the list.
 *
 * `ids` is typed `unknown` on purpose. This is a POST endpoint, so the array
 * arriving here is whatever the caller sent — the service validates it rather
 * than trusting a type that only existed at compile time.
 *
 * Succeeds with a report even when some accounts were refused, so the UI can
 * name them. Only authorization and a malformed list fail outright.
 */
export async function deleteAccountsAction(ids: unknown) {
  return run(
    async (context) => accountsService.softDeleteAccounts(ids, context),
    [ROUTES.ACCOUNTS],
  );
}

/**
 * Declares one problem on each of the selected accounts.
 *
 * The work is done by the problems module. M08 is explicit that no other module
 * may create or resolve problems directly, and this does not: it resolves the
 * caller and hands the ids straight to `bulkProblemsService`, which calls the
 * same `report` a single account screen calls.
 *
 * The action lives here rather than beside the other problem actions because
 * the caller is the accounts list, and a client component may only import
 * actions from its own module — a module barrel would drag server-only code
 * into the browser bundle.
 *
 * Both arguments are `unknown`: this is a POST endpoint, so what arrives is
 * whatever the caller sent, and the service validates it.
 */
export async function declareProblemsForAccountsAction(ids: unknown, input: unknown) {
  return run(
    async (context) => bulkProblemsService.declareForAccounts(ids, input, context),
    [ROUTES.ACCOUNTS, ROUTES.PROBLEMS, ROUTES.CUSTOMERS],
  );
}

/** Resolves every open problem on each of the selected accounts. */
export async function resolveProblemsForAccountsAction(ids: unknown, input: unknown) {
  return run(
    async (context) => bulkProblemsService.resolveForAccounts(ids, input, context),
    [ROUTES.ACCOUNTS, ROUTES.PROBLEMS, ROUTES.CUSTOMERS],
  );
}

/**
 * Builds the accounts CSV.
 *
 * A read, so nothing is revalidated and nothing is audited beyond the usual
 * request logging. Authorization is the service’s, by the same permission the
 * accounts page requires — this is a POST endpoint, and the Export button being
 * hidden would protect nothing.
 *
 * `params` is the page’s query string, re-parsed server-side so the export
 * cannot be pointed at a filter the screen would refuse.
 */
export async function exportAccountsAction(scope: unknown, params: unknown, ids: unknown) {
  return run(async (context) =>
    accountExportService.exportAccounts(context.actor, scope, params, ids),
  );
}

/**
 * Returns the decrypted password.
 *
 * ADR-006 Decision 4: the only path by which plaintext reaches a browser, and
 * only in response to a deliberate click. The service audits every call.
 */
export async function revealAccountPasswordAction(id: string) {
  return run(async (context) => accountsService.revealPassword(id, context));
}

export async function updateProfileAction(accountId: string, profileId: string, input: unknown) {
  return run(
    async (context) => {
      const result = await profilesService.updateProfile(profileId, input, context);

      return result.ok ? { ok: true as const, value: result.value.profile } : result;
    },
    [`${ROUTES.ACCOUNTS}/${accountId}`],
  );
}

/**
 * Returns a sold profile to stock.
 *
 * Revalidates the account page so the card, the indicator strip and the sellable
 * tally all re-render from the database rather than from whatever the browser
 * was last told. The dashboard and Quick Prepare need no invalidation: both
 * count from the live tables on every request, so the profile is back in stock
 * the moment the transaction commits.
 */
export async function unassignSaleAction(accountId: string, profileId: string) {
  return run(
    async (context) => profilesService.unassignSale(profileId, context),
    [`${ROUTES.ACCOUNTS}/${accountId}`, ROUTES.ACCOUNTS, ROUTES.DASHBOARD],
  );
}

/** Paginated, filtered, sorted accounts list. Read-only, still session-gated. */
export async function listAccountsAction(filter: AccountFilter) {
  return run(async () => accountsService.listAccounts(filter));
}
