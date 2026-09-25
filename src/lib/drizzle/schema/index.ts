/**
 * Database schema — single surface.
 *
 * drizzle-kit reads this barrel to generate migrations, and the Database Adapter
 * passes it to the Drizzle client so the relational query API is available.
 *
 * Repositories may import this module. They may NOT import
 * `@/lib/drizzle/client` — ADR-005 Decision 5 places the architectural boundary
 * at the connection, not at the query builder. ESLint enforces it.
 *
 * Deferred tables (ADR-005 Decision 1): orders. `notifications` arrived in M05.
 *
 * `issues` arrived in M08 and `timeline_events` was cancelled outright by
 * ADR-006 Decision 1, so neither is deferred any longer.
 */

export * from "./enums";

export * from "./users";
export * from "./customers";
export * from "./accounts";
export * from "./profiles";
export * from "./profile-events";
export * from "./issues";
export * from "./audit-logs";
export * from "./login-history";
export * from "./backups";
export * from "./settings";
export * from "./report-presets";
export * from "./notifications";

export * from "./relations";
