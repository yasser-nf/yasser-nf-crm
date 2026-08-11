import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";
import { REPORT_KEYS, type ReportKey } from "@/modules/reports";

/**
 * Reports integration tests, against the real database.
 *
 * Every report is executed. That matters more here than in most modules: each
 * one is hand-written aggregate SQL that TypeScript cannot check, so a wrong
 * column name or a bad cast only surfaces when the query actually runs.
 *
 * Read-only apart from presets, which are created and removed inside the suite.
 *
 * Skipped automatically when no real project is configured.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;
let worker: AppUser;

beforeAll(async () => {
  if (!configured) return;

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const admin = admins[0];
  if (!admin) throw new Error("No active Super Admin to authorize as");

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

  const row = workers[0];

  worker = row
    ? { id: row.id, email: row.email, displayName: row.name, initials: "WK", role: "worker" }
    : {
        id: "3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607",
        email: "worker@example.invalid",
        displayName: "Worker",
        initials: "WK",
        role: "worker",
      };
});

afterAll(async () => {
  if (!configured) return;

  await sql!`delete from public.report_presets where name like 'M10 test%'`;
  await sql!.end({ timeout: 5 });
});

async function service() {
  return (await import("@/modules/reports/services/reports.service")).reportsService;
}

describe.skipIf(!configured)("every report runs against the live schema", () => {
  for (const key of REPORT_KEYS) {
    it(`runs the ${key} report`, async () => {
      const reportsService = await service();
      const result = await reportsService.run(key as ReportKey, {}, superAdmin);

      expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

      if (result.ok) {
        expect(result.value.definition.key).toBe(key);
        expect(Array.isArray(result.value.rows)).toBe(true);
        expect(result.value.total).toBeGreaterThanOrEqual(0);

        /* Every row must expose the columns the definition promises exports. */
        for (const row of result.value.rows) {
          for (const column of result.value.definition.columns) {
            expect(column.key in row, `${key} row is missing ${column.key}`).toBe(true);
          }
        }
      }
    });
  }

  it("returns summary aggregates as numbers, not strings", async () => {
    const reportsService = await service();
    const result = await reportsService.run("accounts", {}, superAdmin);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(typeof result.value.summary["total"]).toBe("number");
      expect(typeof result.value.summary["healthy"]).toBe("number");
    }
  });

  it("composes the system health report from the M09 rule", async () => {
    const reportsService = await service();
    const result = await reportsService.run("system-health", {}, superAdmin);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(["green", "yellow", "red", "unknown"]).toContain(result.value.summary["overall"]);
      expect(result.value.rows.length).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!configured)("filters and search", () => {
  it("applies a date range", async () => {
    const reportsService = await service();

    const wide = await reportsService.run("problems", { from: "2000-01-01" }, superAdmin);
    const narrow = await reportsService.run(
      "problems",
      { from: "2099-01-01", to: "2099-12-31" },
      superAdmin,
    );

    expect(wide.ok).toBe(true);
    expect(narrow.ok).toBe(true);

    if (wide.ok && narrow.ok) {
      /* A future window cannot contain anything already recorded. */
      expect(narrow.value.total).toBe(0);
      expect(narrow.value.total).toBeLessThanOrEqual(wide.value.total);
    }
  });

  it("applies a status filter", async () => {
    const reportsService = await service();
    const result = await reportsService.run("backups", { status: "verified" }, superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      for (const row of result.value.rows) {
        expect(row["status"]).toBe("verified");
      }
    }
  });

  it("applies search and narrows the result", async () => {
    const reportsService = await service();

    const all = await reportsService.run("users", {}, superAdmin);
    const searched = await reportsService.run(
      "users",
      { search: "zzz-no-such-user-zzz" },
      superAdmin,
    );

    expect(all.ok).toBe(true);
    expect(searched.ok).toBe(true);

    if (all.ok && searched.ok) {
      expect(searched.value.total).toBe(0);
      expect(all.value.total).toBeGreaterThan(0);
    }
  });

  it("pages a dataset without overlapping rows", async () => {
    const reportsService = await service();

    const first = await reportsService.run("users", {}, superAdmin, { limit: 1, offset: 0 });
    const second = await reportsService.run("users", {}, superAdmin, { limit: 1, offset: 1 });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (first.ok && second.ok && first.value.rows[0] && second.value.rows[0]) {
      expect(first.value.rows[0]["email"]).not.toBe(second.value.rows[0]["email"]);
    }
  });
});

describe.skipIf(!configured)("RBAC — reports respect their declared permission", () => {
  it("lets a Worker run only the operational reports", async () => {
    const reportsService = await service();
    const allowed = reportsService.catalogue(worker).map((report) => report.key);

    expect(allowed).toContain("accounts");
    expect(allowed).toContain("problems");
    expect(allowed).not.toContain("users");
    expect(allowed).not.toContain("backups");
    expect(allowed).not.toContain("audit-summary");
  });

  it("refuses a Worker running an administrative report", async () => {
    const reportsService = await service();

    for (const restricted of [
      "users",
      "backups",
      "audit-summary",
      "system-health",
    ] as ReportKey[]) {
      const result = await reportsService.run(restricted, {}, worker);

      expect(result.ok, `worker ran ${restricted}`).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
    }
  });

  it("refuses an unauthenticated caller every report", async () => {
    const reportsService = await service();

    for (const key of REPORT_KEYS) {
      expect((await reportsService.run(key as ReportKey, {}, null)).ok, key).toBe(false);
    }
  });

  it("refuses export pages to a Worker for a restricted report", async () => {
    /* The export route calls this per page, so the refusal has to live here. */
    const reportsService = await service();
    const result = await reportsService.datasetPage("backups", {}, worker, 100, 0);

    expect(result.ok).toBe(false);
  });
});

describe.skipIf(!configured)("saved presets", () => {
  let presetId: string | null = null;

  it("saves a preset owned by the caller", async () => {
    const reportsService = await service();

    const result = await reportsService.savePreset(
      {
        report: "problems",
        name: "M10 test preset",
        filters: { severity: "critical" },
        columns: ["accountEmail", "severity"],
        sort: {},
        exportFormat: "csv",
      },
      superAdmin,
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      presetId = result.value.id;
      expect(result.value.userId).toBe(superAdmin.id);
    }
  });

  it("updates rather than duplicating when the same name is saved again", async () => {
    const reportsService = await service();

    const again = await reportsService.savePreset(
      {
        report: "problems",
        name: "M10 test preset",
        filters: { severity: "high" },
        columns: [],
        sort: {},
        exportFormat: "excel",
      },
      superAdmin,
    );

    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.id).toBe(presetId);

    const rows = await sql!<{ n: number }[]>`
      select count(*)::int as n from public.report_presets where name = 'M10 test preset'
    `;

    expect(rows[0]!.n).toBe(1);
  });

  it("refuses a preset for a report the caller may not run", async () => {
    const reportsService = await service();

    const result = await reportsService.savePreset(
      {
        report: "backups",
        name: "M10 test forbidden",
        filters: {},
        columns: [],
        sort: {},
        exportFormat: "csv",
      },
      worker,
    );

    expect(result.ok).toBe(false);
  });

  it("never returns another person's presets", async () => {
    const reportsService = await service();
    const theirs = await reportsService.listPresets(worker, "problems");

    expect(theirs.ok).toBe(true);
    if (theirs.ok) {
      expect(theirs.value.every((preset) => preset.userId === worker.id)).toBe(true);
      expect(theirs.value.some((preset) => preset.id === presetId)).toBe(false);
    }
  });

  it("deletes only the caller's own preset", async () => {
    const reportsService = await service();

    const notMine = await reportsService.deletePreset(presetId!, worker);
    expect(notMine.ok).toBe(false);

    const mine = await reportsService.deletePreset(presetId!, superAdmin);
    expect(mine.ok, mine.ok ? "" : String(mine.error)).toBe(true);
  });
});

describe.skipIf(!configured)("export streaming", () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();

    /*
     * ignoreBOM: true means "do not consume the BOM", so it survives into the
     * decoded string. The default strips it — which would have made the BOM
     * assertion below fail against an export that emits one correctly.
     */
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let text = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    return text + decoder.decode();
  }

  it("streams a CSV with a BOM, a header and closed rows", async () => {
    const { exportService } = await import("@/modules/reports/services/export.service");

    const descriptor = await exportService.build("users", "csv", {}, superAdmin, new Date());
    const text = await drain(descriptor.stream);

    expect(descriptor.filename).toMatch(/^users-.*\.csv$/);
    expect(descriptor.mime).toContain("text/csv");
    expect(text.startsWith("﻿")).toBe(true);
    expect(text).toContain("Name,Email,Role,Status");
  });

  it("streams a well-formed Excel document", async () => {
    const { exportService } = await import("@/modules/reports/services/export.service");

    const descriptor = await exportService.build("users", "excel", {}, superAdmin, new Date());
    const text = await drain(descriptor.stream);

    expect(descriptor.filename).toMatch(/\.xls$/);
    expect(text.startsWith("<?xml")).toBe(true);
    expect(text.endsWith("</Workbook>")).toBe(true);

    const opened = (text.match(/<Row>/g) ?? []).length;
    const closed = (text.match(/<\/Row>/g) ?? []).length;
    expect(opened).toBe(closed);
  });

  it("produces a printable document for PDF", async () => {
    const { exportService } = await import("@/modules/reports/services/export.service");

    const descriptor = await exportService.build("users", "pdf", {}, superAdmin, new Date());
    const text = await drain(descriptor.stream);

    expect(text).toContain("<!doctype html>");
    expect(text).toContain("window.print()");
    expect(text).toContain("table-header-group");
  });

  it("exports only the filtered rows", async () => {
    /*
     * The requirement that matters most: an export must never contain rows the
     * screen was filtering out.
     */
    const { exportService } = await import("@/modules/reports/services/export.service");

    const descriptor = await exportService.build(
      "users",
      "csv",
      { search: "zzz-no-such-user-zzz" },
      superAdmin,
      new Date(),
    );

    const text = await drain(descriptor.stream);
    const lines = text.trim().split("\r\n").filter(Boolean);

    /* Header only. */
    expect(lines).toHaveLength(1);
  });

  it("streams in pages rather than one buffered read", async () => {
    const { exportService, EXPORT_PAGE_SIZE } =
      await import("@/modules/reports/services/export.service");

    expect(EXPORT_PAGE_SIZE).toBeGreaterThan(0);

    /* A stream that never yields to its consumer is not a stream. */
    const descriptor = await exportService.build("problems", "csv", {}, superAdmin, new Date());
    const reader = descriptor.stream.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toBeInstanceOf(Uint8Array);

    await reader.cancel();
  });
});
