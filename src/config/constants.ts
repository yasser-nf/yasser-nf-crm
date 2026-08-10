/**
 * Application-wide constants.
 *
 * 01_MASTER_RULES.md forbids hardcoded business data. Values here are structural
 * (routes, limits, keys) rather than business data.
 */

/**
 * Routes.
 *
 * 02_ARCHITECTURE.md v1.1: this list matches the Sidebar exactly.
 * Never write a route string inline. Import it.
 */
export const ROUTES = {
  LOGIN: "/login",

  DASHBOARD: "/dashboard",
  ACCOUNTS: "/accounts",
  QUICK_PREPARE: "/quick-prepare",
  CUSTOMERS: "/customers",
  PROBLEMS: "/problems",
  USERS: "/users",
  REPORTS: "/reports",
  BACKUPS: "/backups",
  LOGS: "/logs",
  SETTINGS: "/settings",
} as const;

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES];

/** The only route a guest may reach. Everything else redirects here. */
export const PUBLIC_ROUTES: readonly string[] = [ROUTES.LOGIN];

/** Where an authenticated user lands. */
export const DEFAULT_AUTHENTICATED_ROUTE = ROUTES.DASHBOARD;

/**
 * Query string key used to preserve the originally requested route across a
 * login redirect, so the user returns to where they were headed.
 */
export const REDIRECT_QUERY_PARAM = "next";

export const APP_NAME = "Yasser NF CRM";
export const APP_DESCRIPTION = "Internal Netflix subscription management system";

/**
 * Application version, recorded inside every backup.
 *
 * Declared here rather than imported from package.json: importing it would pull
 * the whole manifest — including devDependencies — into the bundle. A unit test
 * asserts this equals package.json's version, so the duplication cannot drift
 * silently, which is the only real objection to declaring it twice.
 */
export const APP_VERSION = "0.1.0";

/**
 * Pagination.
 * 01_MASTER_RULES.md: all lists are paginated.
 */
export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,
} as const;

/** Zustand persistence keys. Namespaced to avoid collisions in localStorage. */
export const STORAGE_KEYS = {
  SIDEBAR: "ynf-crm:sidebar",
} as const;
