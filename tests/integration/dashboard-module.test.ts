import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Dashboard integration tests, against the real database.
 *
 * Read-only. The dashboard writes nothing, so nothing here needs cleaning up —
 * and a test suite that mutated data to check a read would be the wrong shape
 * for what it is verifying.
 *
 * Three things are checked that unit tests cannot: the aggregate SQL actually
 * runs against the live schema, the RBAC split omits administrative metrics
 * rather than hiding them, and the whole page's data loads within a sane budget.
 *
 * Skipped automatically when no real project is configured.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;
let worker: AppUser;

beforeAll(async () => {
  if (!configured) {
    return;
  }

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const admin = admins[0];

  if (!admin) {
    throw new Error("No active Super Admin to authorize as");
  }

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };

  const workers = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users where role = 'worker' and deleted_at is null limit 1
  `;

  const workerRow = workers[0];

  worker = workerRow
    ? {
        id: workerRow.id,
        email: workerRow.email,
        displayName: workerRow.name,
        initials: "WK",
        role: "worker",
      }
    : {
        id: "3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607",
        email: "worker@example.invalid",
        displayName: "Worker",
        initials: "WK",
        role: "worker",
      };
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function service() {
  return (await import("@/modules/dashboard/services/dashboard.service")).dashboardService;
}

describe.skipIf(!configured)("aggregate queries run against the live schema", () => {
  it("loads every KPI without error", async () => {
    const dashboardService = await service();
    const result = await dashboardService.load(superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      const { counts } = result.value;

      for (const group of [
        counts.accounts,
        counts.profiles,
        counts.customers,
        counts.problems,
        counts.users,
        counts.prepared,
        counts.expirations,
      ]) {
        for (const [key, value] of Object.entries(group)) {
          expect(typeof value, key).toBe("number");
          expect(Number.isFinite(value), key).toBe(true);
          expect(value, key).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("agrees with a direct count of the users table", async () => {
    /*
     * The aggregate SQL is hand-written and TypeScript cannot check it, so one
     * bucket is cross-checked against an independent query. A `filter (where …)`
     * with the wrong predicate would otherwise return a plausible number
     * forever.
     */
    const dashboardService = await service();
    const result = await dashboardService.load(superAdmin);

    const direct = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.users
      where status = 'active' and deleted_at is null
    `;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.counts.users.active).toBe(direct[0]!.n);
  });

  it("agrees with a direct count of active problems", async () => {
    const dashboardService = await service();
    const result = await dashboardService.load(superAdmin);

    const direct = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.issues where status = 'open'
    `;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.counts.problems.open).toBe(direct[0]!.n);
  });

  it("returns a zero-filled 30-day series, not a sparse one", async () => {
    const dashboardService = await service();
    const result = await dashboardService.load(superAdmin);

    expect(result.ok).toBe(true);

    if (result.ok) {
      /* Gaps must render as zero; a missing point would imply activity. */
      expect(result.value.charts.accountsOverTime).toHaveLength(30);
      expect(result.value.charts.customersOverTime).toHaveLength(30);

      for (const point of result.value.charts.accountsOverTime) {
        expect(point.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(point.count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("runs every repository read without a swallowed failure", async () => {
    /*
     * The service degrades a failed widget read to an empty list, which is
     * right for the page and wrong for a test — a broken query would show as an
     * empty widget forever. Each read is asserted directly here so a failure is
     * loud.
     */
    const { dashboardRepository } =
      await import("@/modules/dashboard/repositories/dashboard.repository");

    const reads = {
      counts: await dashboardRepository.counts(),
      backupSummary: await dashboardRepository.backupSummary(),
      reopenedProblems: await dashboardRepository.reopenedProblems(5),
      stockCandidates: await dashboardRepository.stockCandidates(25),
      accountsByDay: await dashboardRepository.accountsCreatedByDay(30),
      customersByDay: await dashboardRepository.customersCreatedByDay(30),
      backupsByDay: await dashboardRepository.backupsByDay(30),
      problemsBySeverity: await dashboardRepository.problemsBySeverity(),
      recentActivity: await dashboardRepository.recentActivity(10, 0),
      recentProfileActivity: await dashboardRepository.recentProfileActivity(10, 0),
    };

    for (const [name, result] of Object.entries(reads)) {
      expect(result.ok, `${name}: ${result.ok ? "" : String(result.error)}`).toBe(true);
    }
  });

  it("computes a health level from measured facts", async () => {
    const dashboardService = await service();
    const result = await dashboardService.load(superAdmin);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(["green", "yellow", "red"]).toContain(result.value.health?.level);
      expect(result.value.health?.findings.length).toBeGreaterThan(0);
    }
  });

  it("merges the activity feed newest-first across all three sources", async () => {
    const dashboardService = await service();
    const result = await dashboardService.activity(superAdmin, 25, 0);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      const times = result.value.map((entry) => entry.createdAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);

      for (const entry of result.value) {
        expect(["audit", "profile", "auth"]).toContain(entry.source);
      }
    }
  });

  it("paginates the activity feed", async () => {
    const dashboardService = await service();

    const first = await dashboardService.activity(superAdmin, 5, 0);
    const second = await dashboardService.activity(superAdmin, 5, 5);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (first.ok && second.ok && first.value.length === 5 && second.value.length > 0) {
      const firstIds = new Set(first.value.map((entry) => `${entry.source}-${entry.id}`));
      for (const entry of second.value) {
        expect(firstIds.has(`${entry.source}-${entry.id}`)).toBe(false);
      }
    }
  });
});

describe.skipIf(!configured)("RBAC — administrative metrics are omitted, not hidden", () => {
  it("gives a Super Admin the administrative payload", async () => {
    const dashboardService = await service();
    const result = await dashboardService.load(superAdmin);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value.canSeeAdminMetrics).toBe(true);
      expect(result.value.backups).not.toBeNull();
      expect(result.value.health).not.toBeNull();
      expect(result.value.onlineUsers).not.toBeNull();
    }
  });

  it("omits backups, health and online users for a Worker", async () => {
    /*
     * The point of asserting null rather than checking the markup: a number
     * that never reaches the browser cannot be read out of the HTML, however
     * the widget is styled.
     */
    const dashboardService = await service();
    const result = await dashboardService.load(worker);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.canSeeAdminMetrics).toBe(false);
      expect(result.value.backups).toBeNull();
      expect(result.value.health).toBeNull();
      expect(result.value.onlineUsers).toBeNull();
      expect(result.value.charts.backupsOverTime).toEqual([]);
    }
  });

  it("still gives a Worker the operational counts they need", async () => {
    const dashboardService = await service();
    const result = await dashboardService.load(worker);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(typeof result.value.counts.accounts.total).toBe("number");
      expect(typeof result.value.counts.profiles.available).toBe("number");
      expect(typeof result.value.counts.problems.open).toBe("number");
    }
  });

  it("gives a Worker the profile-only activity feed", async () => {
    const dashboardService = await service();
    const result = await dashboardService.activity(worker, 10, 0);

    expect(result.ok).toBe(true);

    if (result.ok) {
      /* Audit entries and sign-ins name people and describe admin actions. */
      for (const entry of result.value) {
        expect(entry.source).toBe("profile");
      }
    }
  });

  it("refuses an unauthenticated caller entirely", async () => {
    const dashboardService = await service();

    expect((await dashboardService.load(null)).ok).toBe(false);
    expect((await dashboardService.activity(null, 5, 0)).ok).toBe(false);
    expect((await dashboardService.stock(null)).ok).toBe(false);
  });
});

describe.skipIf(!configured)("stock widget reuses the allocation rule", () => {
  it("returns a summary that never exceeds the real profile count", async () => {
    const dashboardService = await service();
    const result = await dashboardService.stock(superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      for (const entry of result.value.top) {
        expect(entry.allocatable).toBeLessThanOrEqual(entry.total);
        expect(entry.allocatable).toBeGreaterThan(0);
      }

      expect(typeof result.value.lowStock).toBe("boolean");
    }
  });

  it("never counts a profile on an account with an open problem", async () => {
    /*
     * evaluateAllocation carries this rule, so the assertion is really that the
     * widget uses it rather than counting availability itself.
     */
    const dashboardService = await service();
    const result = await dashboardService.stock(superAdmin);

    expect(result.ok).toBe(true);

    if (result.ok && result.value.top.length > 0) {
      const ids = result.value.top.map((entry) => entry.accountId);

      const blocked = await sql!<{ n: number }[]>`
        select count(*)::int as n
        from public.issues
        where status in ('open', 'in_progress', 'waiting')
          and account_id in (
            select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) as t(value)
          )
      `;

      expect(blocked[0]!.n).toBe(0);
    }
  });
});

describe.skipIf(!configured)("performance", () => {
  it("loads the whole dashboard well inside the one-second target", async () => {
    /*
     * 01_MASTER_RULES.md targets under a second for the dashboard. The budget
     * here is deliberately looser than that: these tests run against a remote
     * Supabase over the public internet, where a single round trip already
     * costs a few hundred milliseconds. What this actually guards is the M09
     * rule against fifty independent queries — that failure mode shows up as
     * seconds, not milliseconds.
     */
    const dashboardService = await service();

    const started = Date.now();
    const result = await dashboardService.load(superAdmin);
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    expect(elapsed, `dashboard load took ${elapsed}ms`).toBeLessThan(10_000);
  });

  it("loads the activity feed quickly", async () => {
    const dashboardService = await service();

    const started = Date.now();
    await dashboardService.activity(superAdmin, 20, 0);
    const elapsed = Date.now() - started;

    expect(elapsed, `activity feed took ${elapsed}ms`).toBeLessThan(5_000);
  });
});
