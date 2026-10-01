/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BackupSchedulerStatus } from "@/modules/backups/components/scheduler-status";
import {
  DEPLOYED_TRIGGER,
  formatHourUtc,
  type SchedulerStatus,
} from "@/modules/backups/services/schedule";
import { scheduleEnforcement } from "@/modules/backups/services/schedule-enforcement";
import {
  definitionsForCategory,
  enforcementNote,
  withEnforcement,
} from "@/modules/settings/services/settings-definitions";

/**
 * M07 cleanup: what Settings → Backups says about the scheduler.
 *
 * The catalogue declares the schedule "not enforced — awaiting a scheduler
 * trigger". Once production had one, that was false. These tests pin the
 * replacement: configured and not configured are different states, and so are
 * "configured" and "has run" — a trigger that has not fired yet never reads as
 * running.
 */

afterEach(cleanup);

const status = (overrides: Partial<SchedulerStatus> = {}): SchedulerStatus => ({
  frequency: "daily",
  hourUtc: 2,
  configured: true,
  nextScheduledAt: new Date("2026-10-02T02:00:00Z"),
  lastScheduledAt: null,
  ...overrides,
});

const FREQUENCY = "backup.schedule.frequency";
const HOUR = "backup.schedule.hourUtc";

function notes(current: SchedulerStatus): Record<string, string | null> {
  const definitions = withEnforcement(
    definitionsForCategory("backups"),
    scheduleEnforcement(current),
  );
  return Object.fromEntries(
    definitions.map((definition) => [definition.key, enforcementNote(definition)]),
  );
}

describe("the deployed trigger", () => {
  it("is the cron in vercel.json", () => {
    const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
      crons?: { path: string; schedule: string }[];
    };

    expect(config.crons).toEqual([
      { path: DEPLOYED_TRIGGER.path, schedule: DEPLOYED_TRIGGER.schedule },
    ]);
    expect(DEPLOYED_TRIGGER.schedule).toBe(`0 ${DEPLOYED_TRIGGER.hourUtc} * * *`);
    expect(formatHourUtc(DEPLOYED_TRIGGER.hourUtc)).toBe("02:00");
  });
});

describe("the schedule settings' enforcement badge", () => {
  it("keeps 'awaiting a scheduler trigger' while no trigger is configured", () => {
    const shown = notes(status({ configured: false }));

    expect(shown[FREQUENCY]).toMatch(/not yet enforced — awaiting a scheduler trigger/);
    expect(shown[HOUR]).toMatch(/not yet enforced — awaiting a scheduler trigger/);
  });

  it("drops it once a trigger is configured and the schedule is served as written", () => {
    for (const frequency of ["daily", "weekly", "monthly", "off"] as const) {
      const shown = notes(status({ frequency }));
      expect(shown[FREQUENCY]).toBeNull();
      expect(shown[HOUR]).toBeNull();
    }
  });

  it("still flags an hourly schedule: the deployed cron calls once a day", () => {
    const shown = notes(status({ frequency: "hourly" }));

    expect(shown[FREQUENCY]).toMatch(/awaiting an hourly trigger .*once a day, at 02:00 UTC/);
    expect(shown[HOUR]).toBeNull();
  });

  it("still flags an hour the cron does not call at", () => {
    const shown = notes(status({ frequency: "weekly", hourUtc: 14 }));

    expect(shown[FREQUENCY]).toBeNull();
    expect(shown[HOUR]).toMatch(/awaiting a trigger at 14:00 UTC .*calls at 02:00 UTC/);
  });

  it("leaves every other setting's own state alone", () => {
    const overridden = withEnforcement(definitionsForCategory("backups"), {
      [FREQUENCY]: { state: "enforced" },
    });

    for (const definition of overridden) {
      if (definition.key === FREQUENCY) continue;
      const original = definitionsForCategory("backups").find((d) => d.key === definition.key);
      expect(definition.enforcement).toEqual(original?.enforcement);
    }
    expect(withEnforcement(definitionsForCategory("backups"), undefined)).toEqual(
      definitionsForCategory("backups"),
    );
  });
});

describe("the scheduler panel", () => {
  it("configured, not yet run: the schedule and next slot — never a run that has not happened", () => {
    render(<BackupSchedulerStatus status={status()} />);

    expect(screen.getByText("Daily, 02:00 UTC")).toBeTruthy();
    expect(
      screen.getByText(
        /Scheduler configured — the cron calls \/api\/cron\/backups daily at 02:00 UTC/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("Next slot: 2026-10-02 02:00 UTC.")).toBeTruthy();
    expect(screen.getByText("No scheduled backup has run yet.")).toBeTruthy();
    expect(screen.queryByText(/Last scheduled backup/)).toBeNull();
    expect(screen.queryByText(/Not running|awaiting/i)).toBeNull();
  });

  it("configured and run: when the last scheduled backup was taken", () => {
    render(
      <BackupSchedulerStatus
        status={status({ lastScheduledAt: new Date("2026-10-02T02:03:11Z") })}
      />,
    );

    expect(screen.getByText("Last scheduled backup: 2026-10-02 02:03 UTC.")).toBeTruthy();
    expect(screen.queryByText("No scheduled backup has run yet.")).toBeNull();
  });

  it("not configured: not running, and why", () => {
    render(<BackupSchedulerStatus status={status({ configured: false })} />);

    expect(screen.getByText("Not running")).toBeTruthy();
    expect(screen.getByText(/no scheduler trigger is configured \(CRON_SECRET\)/)).toBeTruthy();
    expect(screen.queryByText(/Scheduler configured/)).toBeNull();
    expect(screen.queryByText(/Next slot/)).toBeNull();
  });

  it("off: says so, and nothing about runs", () => {
    render(<BackupSchedulerStatus status={status({ frequency: "off", nextScheduledAt: null })} />);

    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.queryByText(/scheduled backup/)).toBeNull();
  });

  it("weekly and monthly name their day; hourly has no hour", () => {
    render(<BackupSchedulerStatus status={status({ frequency: "weekly", hourUtc: 5 })} />);
    expect(screen.getByText("Weekly (Mondays), 05:00 UTC")).toBeTruthy();
    cleanup();

    render(<BackupSchedulerStatus status={status({ frequency: "hourly" })} />);
    expect(screen.getByText("Hourly")).toBeTruthy();
  });
});
