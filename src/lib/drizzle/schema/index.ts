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
 * Deferred tables (ADR-005 Decision 1): orders, issues, timeline_events,
 * notifications.
 */

export * from "./enums";

export * from "./users";
export * from "./customers";
export * from "./accounts";
export * from "./profiles";
export * from "./profile-events";
export * from "./audit-logs";
export * from "./login-history";
export * from "./backups";
export * from "./settings";

export * from "./relations";
