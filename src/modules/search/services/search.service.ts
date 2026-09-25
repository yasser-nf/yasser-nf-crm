import "server-only";

import { ROUTES } from "@/config/constants";
import { PERMISSIONS, ROLE_LABELS, USER_STATUS_LABELS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import type { ProfileRow } from "@/lib/drizzle/schema";
import { DatabaseError, ForbiddenError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { formatPhoneForDisplay } from "@/lib/phone";
import {
  accountBadgeStyle,
  accountCanAllocate,
  accountEffectiveStatus,
  profileCellState,
} from "@/modules/accounts";
import { problemsService } from "@/modules/problems";
import { PROBLEM_STATUS_STYLES, PROBLEM_TYPE_LABELS } from "@/shared/ui/problem-badges";
import { PROFILE_STATE_LABELS, PROFILE_STATE_STYLES } from "@/shared/ui/profile-state";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  searchRepository,
  type AccountHitRow,
  type ProfileHitRow,
} from "../repositories/search.repository";
import {
  SEARCH_GROUP_LIMIT,
  SEARCH_MAX_LENGTH,
  buildSearchTerms,
  normalizeQuery,
} from "./search-terms";
import type { SearchGroup, SearchGroupKind, SearchHit, SearchResponse } from "./search-types";

/**
 * Global search (M05).
 *
 * AUTHORIZATION IS PER GROUP, ON THE SERVER. A group this person may not see is
 * never queried — not queried and then hidden. The rule for each group is the
 * permission its own page already demands:
 *
 *   accounts, profiles   VIEW_ACCOUNTS    (profiles live on the account page)
 *   customers            VIEW_CUSTOMERS
 *   problems             VIEW_PROBLEMS
 *   users                MANAGE_USERS     (Super Admin only — the Users page)
 *
 * and the whole search needs SEARCH. So a Worker can find accounts, profiles,
 * customers and problems, exactly as they can browse them, and never a user.
 *
 * ERROR IS NOT EMPTY. Each group answers independently: one failing query marks
 * that group "error" and the others still show. Only when every group fails
 * does the search itself fail. A group with no matches is an empty list, which
 * the box shows as "no results" — never the same thing as a failure.
 *
 * STATE IS DERIVED, NOT STORED. An account's badge comes from
 * `accountEffectiveStatus` and a profile's from `profileCellState`, fed the
 * blocking problems from `problemsService.accountsWithActiveProblems` — the
 * inputs the Accounts page uses. If those problems cannot be read, the account
 * and profile groups report an error rather than a badge that might say
 * "Healthy" about a blocked account.
 */

const GROUP_LABELS: Record<SearchGroupKind, string> = {
  accounts: "Accounts",
  profiles: "Profiles",
  customers: "Customers",
  problems: "Problems",
  users: "Users",
};

function errorGroup(kind: SearchGroupKind): SearchGroup {
  return { kind, label: GROUP_LABELS[kind], status: "error" };
}

function okGroup(
  kind: SearchGroupKind,
  hits: SearchHit[],
  viewAll: string | null,
  query: string,
): SearchGroup {
  const hasMore = hits.length > SEARCH_GROUP_LIMIT;

  return {
    kind,
    label: GROUP_LABELS[kind],
    status: "ok",
    hits: hits.slice(0, SEARCH_GROUP_LIMIT),
    hasMore,
    viewAllHref: hasMore && viewAll ? `${viewAll}?search=${encodeURIComponent(query)}` : null,
  };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The profile fields `profileCellState` reads, with nothing else carried along. */
function stateProfile(row: ProfileHitRow["profile"]): ProfileRow {
  return {
    ...row,
    pin: null,
    workerId: null,
    saleDate: null,
    durationDays: null,
    notes: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function accountHit(
  row: AccountHitRow,
  blocking: ReadonlyMap<string, readonly string[]>,
  today: Date,
): SearchHit {
  const style = accountBadgeStyle(accountEffectiveStatus(row, blocking.get(row.id) ?? [], today));

  return {
    id: row.id,
    title: row.email,
    subtitle: null,
    href: `${ROUTES.ACCOUNTS}/${row.id}`,
    badge: { label: style.label, className: style.className },
  };
}

function profileHit(
  row: ProfileHitRow,
  blocking: ReadonlyMap<string, readonly string[]>,
  today: Date,
): SearchHit {
  const canAllocate = accountCanAllocate(
    row.account,
    (blocking.get(row.account.id) ?? []).length > 0,
    today,
  );
  const state = profileCellState(stateProfile(row.profile), row.account, today, canAllocate);

  return {
    id: row.profile.id,
    title: row.profile.profileName ?? `Profile ${row.profile.profileNumber}`,
    subtitle: `Profile ${row.profile.profileNumber} · ${row.account.email}`,
    href: `${ROUTES.ACCOUNTS}/${row.account.id}`,
    badge: {
      label: capitalise(PROFILE_STATE_LABELS[state]),
      className: `border ${PROFILE_STATE_STYLES[state]}`,
    },
  };
}

async function searchAccountsAndProfiles(
  terms: ReturnType<typeof buildSearchTerms>,
  query: string,
  today: Date,
): Promise<[SearchGroup, SearchGroup]> {
  const [accountRows, profileRows] = await Promise.all([
    searchRepository.accounts(terms, SEARCH_GROUP_LIMIT),
    searchRepository.profiles(terms, SEARCH_GROUP_LIMIT),
  ]);

  const accountIds = [
    ...(accountRows.ok ? accountRows.value.map((row) => row.id) : []),
    ...(profileRows.ok ? profileRows.value.map((row) => row.account.id) : []),
  ];

  const blocking = await problemsService.accountsWithActiveProblems([...new Set(accountIds)]);

  if (!blocking.ok) {
    return [errorGroup("accounts"), errorGroup("profiles")];
  }

  return [
    accountRows.ok
      ? okGroup(
          "accounts",
          accountRows.value.map((row) => accountHit(row, blocking.value, today)),
          ROUTES.ACCOUNTS,
          query,
        )
      : errorGroup("accounts"),
    profileRows.ok
      ? okGroup(
          "profiles",
          profileRows.value.map((row) => profileHit(row, blocking.value, today)),
          /* No profiles page exists; the account page is where a profile lives. */
          null,
          query,
        )
      : errorGroup("profiles"),
  ];
}

async function searchCustomers(
  terms: ReturnType<typeof buildSearchTerms>,
  query: string,
): Promise<SearchGroup> {
  const rows = await searchRepository.customers(terms, SEARCH_GROUP_LIMIT);

  if (!rows.ok) {
    return errorGroup("customers");
  }

  return okGroup(
    "customers",
    rows.value.map((row) => {
      const phone = formatPhoneForDisplay(row.phoneNormalized);

      return {
        id: row.id,
        title: row.name?.trim() || phone,
        subtitle: row.name?.trim() ? phone : null,
        href: `${ROUTES.CUSTOMERS}/${row.id}`,
        badge:
          row.blockedAt === null
            ? null
            : { label: "Blocked", className: "bg-danger-subtle text-danger" },
      };
    }),
    ROUTES.CUSTOMERS,
    query,
  );
}

async function searchProblems(
  terms: ReturnType<typeof buildSearchTerms>,
  query: string,
): Promise<SearchGroup> {
  const rows = await searchRepository.problems(terms, SEARCH_GROUP_LIMIT);

  if (!rows.ok) {
    return errorGroup("problems");
  }

  return okGroup(
    "problems",
    rows.value.map((row) => {
      const status = PROBLEM_STATUS_STYLES[row.status];

      return {
        id: row.id,
        title: PROBLEM_TYPE_LABELS[row.issueType] ?? row.issueType,
        subtitle: row.accountEmail,
        href: `${ROUTES.PROBLEMS}/${row.id}`,
        badge: { label: status.label, className: status.className },
      };
    }),
    ROUTES.PROBLEMS,
    query,
  );
}

async function searchUsers(
  terms: ReturnType<typeof buildSearchTerms>,
  query: string,
): Promise<SearchGroup> {
  const rows = await searchRepository.users(terms, SEARCH_GROUP_LIMIT);

  if (!rows.ok) {
    return errorGroup("users");
  }

  return okGroup(
    "users",
    rows.value.map((row) => ({
      id: row.id,
      title: row.name,
      subtitle: `${row.email} · ${ROLE_LABELS[row.role]}`,
      href: `${ROUTES.USERS}/${row.id}`,
      badge:
        row.status === "active"
          ? null
          : {
              label: USER_STATUS_LABELS[row.status],
              className: "bg-neutral-subtle text-foreground-muted",
            },
    })),
    ROUTES.USERS,
    query,
  );
}

async function search(rawQuery: unknown, actor: AppUser | null): Promise<Result<SearchResponse>> {
  if (!actor) {
    return fail(new UnauthorizedError("No signed-in user to search"));
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.SEARCH)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not search`, {
        userMessage: "You do not have permission to search.",
      }),
    );
  }

  if (typeof rawQuery !== "string" || rawQuery.length > SEARCH_MAX_LENGTH * 4) {
    return fail(new ValidationError("Search query is not valid"));
  }

  const query = normalizeQuery(rawQuery);

  /* Too short is not an error and not a search: nothing is asked of the database. */
  if (query === null) {
    return ok({ query: rawQuery.trim(), groups: [] });
  }

  const terms = buildSearchTerms(query);
  const today = new Date();
  const may = (permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS]) =>
    roleHasPermission(actor.role, permission);

  const [accountGroups, customerGroup, problemGroup, userGroup] = await Promise.all([
    may(PERMISSIONS.VIEW_ACCOUNTS) ? searchAccountsAndProfiles(terms, query, today) : null,
    may(PERMISSIONS.VIEW_CUSTOMERS) ? searchCustomers(terms, query) : null,
    may(PERMISSIONS.VIEW_PROBLEMS) ? searchProblems(terms, query) : null,
    may(PERMISSIONS.MANAGE_USERS) ? searchUsers(terms, query) : null,
  ]);

  const groups = [...(accountGroups ?? []), customerGroup, problemGroup, userGroup].filter(
    (group): group is SearchGroup => group !== null,
  );

  if (groups.length > 0 && groups.every((group) => group.status === "error")) {
    return fail(
      new DatabaseError("Every search group failed", {
        userMessage: "Search is unavailable right now. Please try again.",
      }),
    );
  }

  return ok({ query, groups });
}

export const searchService = { search } as const;
