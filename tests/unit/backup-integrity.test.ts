import { describe, expect, it } from "vitest";

import { APP_VERSION } from "@/config/constants";
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLE_NAMES,
  RESTORE_DELETE_ORDER,
  checkCompatibility,
  policyFor,
  type BackupManifest,
} from "@/modules/backups/services/backup-format";
import { checksumService } from "@/modules/backups/services/checksum.service";
import { isDue } from "@/modules/backups/services/snapshot.service";
import packageJson from "../../package.json" with { type: "json" };

/**
 * Integrity, format and schedule tests.
 *
 * The checksum is what everything else trusts: if it is wrong, a corrupted
 * backup verifies clean and a restore writes garbage over live data. It is
 * tested against known SHA-256 values rather than against itself.
 */

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: "2026-08-10T00:00:00.000Z",
    createdBy: null,
    appVersion: APP_VERSION,
    databaseVersion: "PostgreSQL 17.6",
    type: "manual",
    tables: BACKUP_TABLE_NAMES,
    rowCounts: {},
    ...overrides,
  };
}

describe("checksumService", () => {
  it("matches the known SHA-256 of an empty input", () => {
    expect(checksumService.of("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches the known SHA-256 of 'abc'", () => {
    expect(checksumService.of("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("produces the same digest for a Buffer and its string", () => {
    expect(checksumService.of(Buffer.from("hello", "utf8"))).toBe(checksumService.of("hello"));
  });

  it("changes completely when one byte changes", () => {
    const before = checksumService.of("backup-content-v1");
    const after = checksumService.of("backup-content-v2");

    expect(before).not.toBe(after);
  });

  it("accepts an identical checksum", () => {
    const digest = checksumService.of("payload");
    expect(checksumService.matches(digest, digest)).toBe(true);
  });

  it("rejects a different checksum", () => {
    expect(checksumService.matches(checksumService.of("a"), checksumService.of("b"))).toBe(false);
  });

  it("rejects empty and mismatched-length input rather than throwing", () => {
    /* timingSafeEqual throws on unequal buffers; the guard must catch that first. */
    expect(checksumService.matches("", "")).toBe(false);
    expect(checksumService.matches("abc", "abcdef")).toBe(false);
  });

  it("hashes a stream identically to a buffer", async () => {
    const { Readable } = await import("node:stream");
    const content = "a".repeat(10_000);

    const streamed = await checksumService.ofStream(Readable.from([content]));

    expect(streamed).toBe(checksumService.of(content));
  });
});

describe("backup format", () => {
  it("declares APP_VERSION identical to package.json", () => {
    /* The duplication in config/constants.ts is only safe while this holds. */
    expect(APP_VERSION).toBe(packageJson.version);
  });

  it("deletes in exactly the reverse of insert order", () => {
    expect(RESTORE_DELETE_ORDER).toEqual([...BACKUP_TABLE_NAMES].reverse());
  });

  it("puts users before every table that references them", () => {
    const order = BACKUP_TABLE_NAMES;

    expect(order.indexOf("users")).toBeLessThan(order.indexOf("accounts"));
    expect(order.indexOf("accounts")).toBeLessThan(order.indexOf("profiles"));
    expect(order.indexOf("profiles")).toBeLessThan(order.indexOf("profile_events"));
    expect(order.indexOf("customers")).toBeLessThan(order.indexOf("profiles"));
  });

  it("never reconciles the immutable log tables", () => {
    /* 01_MASTER_RULES.md: audit logs are never deleted and never modified. */
    expect(policyFor("audit_logs")).toBe("append_only");
    expect(policyFor("profile_events")).toBe("append_only");
  });

  it("excludes sessions and the backup catalogue itself", () => {
    expect(BACKUP_TABLE_NAMES).not.toContain("login_history");
    expect(BACKUP_TABLE_NAMES).not.toContain("backups");
    expect(BACKUP_TABLE_NAMES).not.toContain("sessions");
  });

  it("refuses a format newer than this build understands", () => {
    const verdict = checkCompatibility(manifest({ formatVersion: BACKUP_FORMAT_VERSION + 1 }));

    expect(verdict.compatible).toBe(false);
  });

  it("accepts the current format", () => {
    expect(checkCompatibility(manifest()).compatible).toBe(true);
  });

  it("refuses a manifest with no usable version", () => {
    expect(checkCompatibility(manifest({ formatVersion: 0 })).compatible).toBe(false);
    expect(
      checkCompatibility(manifest({ formatVersion: 1.5 as unknown as number })).compatible,
    ).toBe(false);
  });

  it("warns rather than refuses when a table is unknown", () => {
    const verdict = checkCompatibility(manifest({ tables: [...BACKUP_TABLE_NAMES, "orders"] }));

    expect(verdict.compatible).toBe(true);
    if (verdict.compatible) {
      expect(verdict.warnings.some((warning) => warning.includes("orders"))).toBe(true);
    }
  });

  it("warns when a table is missing from the backup", () => {
    const verdict = checkCompatibility(manifest({ tables: ["users"] }));

    expect(verdict.compatible).toBe(true);
    if (verdict.compatible) {
      expect(verdict.warnings.some((warning) => warning.includes("customers"))).toBe(true);
    }
  });
});

describe("isDue", () => {
  const now = new Date("2026-08-10T12:00:00Z");

  function hoursAgo(hours: number): Date {
    return new Date(now.getTime() - hours * 60 * 60 * 1000);
  }

  it("is never due when the schedule is off", () => {
    expect(isDue("off", null, now)).toBe(false);
    expect(isDue("off", hoursAgo(10_000), now)).toBe(false);
  });

  it("is due immediately when it has never run", () => {
    expect(isDue("daily", null, now)).toBe(true);
  });

  it("respects each interval", () => {
    expect(isDue("hourly", hoursAgo(0.5), now)).toBe(false);
    expect(isDue("hourly", hoursAgo(1), now)).toBe(true);

    expect(isDue("daily", hoursAgo(23), now)).toBe(false);
    expect(isDue("daily", hoursAgo(24), now)).toBe(true);

    expect(isDue("weekly", hoursAgo(24 * 6), now)).toBe(false);
    expect(isDue("weekly", hoursAgo(24 * 7), now)).toBe(true);

    expect(isDue("monthly", hoursAgo(24 * 29), now)).toBe(false);
    expect(isDue("monthly", hoursAgo(24 * 30), now)).toBe(true);
  });
});
