import { describe, expect, it } from "vitest";

import {
  BACKUP_STALE_HOURS,
  BACKUP_WARNING_HOURS,
  assessHealth,
  type HealthInputs,
} from "@/modules/dashboard/services/system-health";

/**
 * System health tests.
 *
 * The M09 brief: never hardcode the health summary. These fix the rule so a
 * later change that starts returning green unconditionally — the easiest way for
 * a status light to become useless — fails here.
 */

const NOW = new Date("2026-08-11T12:00:00Z");

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 3_600_000);
}

function inputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  return {
    criticalProblems: 0,
    failedBackups: 0,
    lastBackupAt: hoursAgo(1),
    lastChecksumVerified: true,
    databaseReachable: true,
    ...overrides,
  };
}

describe("assessHealth", () => {
  it("is green when every check passes", () => {
    const report = assessHealth(inputs(), NOW);

    expect(report.level).toBe("green");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.message).toContain("passed");
  });

  it("is red when the database cannot be reached, and reports nothing else", () => {
    /* Nothing else is trustworthy if the reads failed. */
    const report = assessHealth(inputs({ databaseReachable: false, criticalProblems: 9 }), NOW);

    expect(report.level).toBe("red");
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.message).toContain("database");
  });

  it("is red while a critical problem is open", () => {
    const report = assessHealth(inputs({ criticalProblems: 1 }), NOW);

    expect(report.level).toBe("red");
    expect(report.findings.some((f) => f.message.includes("critical"))).toBe(true);
  });

  it("is red when no backup has ever completed", () => {
    const report = assessHealth(inputs({ lastBackupAt: null }), NOW);

    expect(report.level).toBe("red");
    expect(report.findings.some((f) => f.message.includes("No backup has ever"))).toBe(true);
  });

  it("is yellow when a backup has failed", () => {
    const report = assessHealth(inputs({ failedBackups: 2 }), NOW);

    expect(report.level).toBe("yellow");
  });

  it("escalates with backup age", () => {
    expect(assessHealth(inputs({ lastBackupAt: hoursAgo(1) }), NOW).level).toBe("green");

    expect(assessHealth(inputs({ lastBackupAt: hoursAgo(BACKUP_WARNING_HOURS) }), NOW).level).toBe(
      "yellow",
    );

    expect(assessHealth(inputs({ lastBackupAt: hoursAgo(BACKUP_STALE_HOURS) }), NOW).level).toBe(
      "red",
    );
  });

  it("is yellow when the latest backup is unverified", () => {
    const report = assessHealth(inputs({ lastChecksumVerified: false }), NOW);

    expect(report.level).toBe("yellow");
    expect(report.findings.some((f) => f.message.includes("checksum"))).toBe(true);
  });

  it("lets the worst finding win rather than averaging", () => {
    /*
     * Three healthy checks must never offset one failing backup. Averaging
     * severities is how a status light stops meaning anything.
     */
    const report = assessHealth(
      inputs({ criticalProblems: 1, failedBackups: 1, lastChecksumVerified: false }),
      NOW,
    );

    expect(report.level).toBe("red");
    expect(report.findings.length).toBeGreaterThan(1);
  });

  it("never reports green while any finding is not green", () => {
    const cases: Partial<HealthInputs>[] = [
      { criticalProblems: 1 },
      { failedBackups: 1 },
      { lastBackupAt: null },
      { lastChecksumVerified: false },
      { lastBackupAt: hoursAgo(100) },
    ];

    for (const override of cases) {
      const report = assessHealth(inputs(override), NOW);
      expect(report.level, JSON.stringify(override)).not.toBe("green");
    }
  });

  it("counts singular and plural correctly", () => {
    expect(assessHealth(inputs({ criticalProblems: 1 }), NOW).findings[0]?.message).toContain(
      "1 critical problem open",
    );
    expect(assessHealth(inputs({ criticalProblems: 2 }), NOW).findings[0]?.message).toContain(
      "2 critical problems open",
    );
  });
});
