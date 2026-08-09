import { relations } from "drizzle-orm";

import { accounts } from "./accounts";
import { auditLogs } from "./audit-logs";
import { backups } from "./backups";
import { customers } from "./customers";
import { loginHistory } from "./login-history";
import { profileEvents } from "./profile-events";
import { profiles } from "./profiles";
import { settings } from "./settings";
import { users } from "./users";

/**
 * Drizzle relations.
 *
 * Declared in one file on purpose. Relations reference tables on both sides, so
 * defining them inside each table's own module would make users.ts import
 * accounts.ts and accounts.ts import users.ts — a cycle. Collecting them here
 * keeps every table module a leaf that depends only on enums, and keeps
 * `madge --circular` clean.
 *
 * These describe the relational query API. The foreign keys themselves are
 * declared on the table columns.
 */

export const usersRelations = relations(users, ({ many }) => ({
  createdAccounts: many(accounts),
  soldProfiles: many(profiles),
  auditLogs: many(auditLogs),
  profileEvents: many(profileEvents),
  requestedBackups: many(backups),
  settingsUpdates: many(settings),
  loginHistory: many(loginHistory),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  /** Profiles currently held. Purchase history arrives with orders. */
  heldProfiles: many(profiles),
  profileEvents: many(profileEvents),
}));

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  createdByUser: one(users, {
    fields: [accounts.createdBy],
    references: [users.id],
  }),
  /** Exactly five, enforced in the service layer. See profiles.ts. */
  profiles: many(profiles),
  /** The account timeline. ADR-006 Decision 1: the only event source. */
  events: many(profileEvents),
}));

export const profilesRelations = relations(profiles, ({ one, many }) => ({
  account: one(accounts, {
    fields: [profiles.accountId],
    references: [accounts.id],
  }),
  currentCustomer: one(customers, {
    fields: [profiles.customerId],
    references: [customers.id],
  }),
  worker: one(users, {
    fields: [profiles.workerId],
    references: [users.id],
  }),
  events: many(profileEvents),
}));

export const profileEventsRelations = relations(profileEvents, ({ one }) => ({
  account: one(accounts, {
    fields: [profileEvents.accountId],
    references: [accounts.id],
  }),
  profile: one(profiles, {
    fields: [profileEvents.profileId],
    references: [profiles.id],
  }),
  actor: one(users, {
    fields: [profileEvents.userId],
    references: [users.id],
  }),
  customer: one(customers, {
    fields: [profileEvents.customerId],
    references: [customers.id],
  }),
}));

export const loginHistoryRelations = relations(loginHistory, ({ one }) => ({
  /**
   * Optional on purpose: a failed attempt against an unknown address has no
   * user to point at, and that is precisely the case worth recording.
   */
  user: one(users, {
    fields: [loginHistory.userId],
    references: [users.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  /**
   * No relation to the audited row: entity_id is deliberately not a foreign key,
   * so the log can outlive what it describes.
   */
  user: one(users, {
    fields: [auditLogs.userId],
    references: [users.id],
  }),
}));

export const backupsRelations = relations(backups, ({ one }) => ({
  createdByUser: one(users, {
    fields: [backups.createdBy],
    references: [users.id],
  }),
}));

export const settingsRelations = relations(settings, ({ one }) => ({
  updatedByUser: one(users, {
    fields: [settings.updatedBy],
    references: [users.id],
  }),
}));
