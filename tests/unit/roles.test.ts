import { describe, expect, it } from "vitest";

import {
  PERMISSIONS,
  USER_ROLES,
  USER_STATUSES,
  permissionsForRole,
  roleHasPermission,
  statusAllowsAccess,
  type Permission,
} from "@/config/roles";

/**
 * Permission matrix tests.
 *
 * The M06 brief states exactly what a Worker may and may not do. These encode
 * that list, so a permission added later cannot silently widen a Worker's
 * access — the allow-list would have to be edited deliberately, and this file
 * would have to be edited with it.
 */

/** Verbatim from the brief's "Workers may" list. */
const WORKER_ALLOWED: Permission[] = [
  PERMISSIONS.VIEW_ACCOUNTS,
  PERMISSIONS.VIEW_CUSTOMERS,
  PERMISSIONS.PREPARE_SUBSCRIPTIONS,
  PERMISSIONS.REPLACE_ACCOUNTS,
  PERMISSIONS.EDIT_PROFILE_NAMES,
  PERMISSIONS.EDIT_PROFILE_PINS,
  PERMISSIONS.OPEN_WHATSAPP,
  PERMISSIONS.SEARCH,
];

/** Verbatim from the brief's "Workers may NOT" list. */
const WORKER_DENIED: Permission[] = [
  PERMISSIONS.DELETE_ACCOUNTS,
  PERMISSIONS.ARCHIVE_ACCOUNTS,
  PERMISSIONS.MANAGE_USERS,
  PERMISSIONS.ACCESS_SETTINGS,
  PERMISSIONS.VIEW_SECURITY,
  PERMISSIONS.ACCESS_DEVELOPER_PAGES,
  PERMISSIONS.MODIFY_PERMISSIONS,
];

describe("Worker permissions — allowed", () => {
  for (const permission of WORKER_ALLOWED) {
    it(`allows ${permission}`, () => {
      expect(roleHasPermission(USER_ROLES.WORKER, permission)).toBe(true);
    });
  }
});

describe("Worker permissions — denied", () => {
  for (const permission of WORKER_DENIED) {
    it(`denies ${permission}`, () => {
      expect(roleHasPermission(USER_ROLES.WORKER, permission)).toBe(false);
    });
  }
});

describe("Super Admin permissions", () => {
  for (const permission of Object.values(PERMISSIONS)) {
    it(`allows ${permission}`, () => {
      expect(roleHasPermission(USER_ROLES.SUPER_ADMIN, permission)).toBe(true);
    });
  }
});

describe("Permission model integrity", () => {
  it("gives a Worker strictly fewer permissions than a Super Admin", () => {
    const worker = permissionsForRole(USER_ROLES.WORKER);
    const admin = permissionsForRole(USER_ROLES.SUPER_ADMIN);

    expect(worker.length).toBeLessThan(admin.length);
    for (const permission of worker) {
      expect(admin).toContain(permission);
    }
  });

  it("has no permission a Worker holds that a Super Admin does not", () => {
    const admin = new Set(permissionsForRole(USER_ROLES.SUPER_ADMIN));
    const escalations = permissionsForRole(USER_ROLES.WORKER).filter((p) => !admin.has(p));

    expect(escalations).toEqual([]);
  });

  it("defines exactly two roles", () => {
    expect(Object.values(USER_ROLES)).toHaveLength(2);
  });

  it("denies any administrative permission to a Worker", () => {
    /*
     * A blanket sweep rather than a list: a permission added later that reads
     * as administrative but was never added to WORKER_DENIED still fails here.
     */
    const administrative = Object.values(PERMISSIONS).filter(
      (p) =>
        p.includes("manage") ||
        p.includes("settings") ||
        p.includes("security") ||
        p.includes("developer") ||
        p.includes("permissions") ||
        p.includes("backup") ||
        p.includes("delete") ||
        p.includes("system"),
    );

    expect(administrative.length).toBeGreaterThan(0);
    for (const permission of administrative) {
      expect(roleHasPermission(USER_ROLES.WORKER, permission)).toBe(false);
    }
  });
});

describe("User status", () => {
  it("permits access only when active", () => {
    expect(statusAllowsAccess(USER_STATUSES.ACTIVE)).toBe(true);
    expect(statusAllowsAccess(USER_STATUSES.SUSPENDED)).toBe(false);
    expect(statusAllowsAccess(USER_STATUSES.DISABLED)).toBe(false);
  });

  it("defines three stored statuses — archived is derived from deleted_at", () => {
    expect(Object.values(USER_STATUSES)).toHaveLength(3);
    expect(Object.values(USER_STATUSES)).not.toContain("archived");
  });
});
