import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";

/**
 * Problems module integration tests, against the real database.
 *
 * These create and mutate real rows, so everything they touch is built inside
 * the suite and removed in `afterAll` — a throwaway account and the problems
 * raised on it. Nothing pre-existing is modified.
 *
 * That is what makes the destructive half of M08 verifiable at all: unlike the
 * M07 restore, a problem lifecycle can be exercised end to end without putting
 * real data at risk.
 *
 * Skipped automatically when no real project is configured.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

/*
 * One connection, not two. This suite runs alongside the application's own
 * Drizzle pool and the Supabase session pooler caps the project at 15 clients —
 * a second connection here is enough to exhaust it on a busy run.
 */
const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

let superAdmin: AppUser;
let worker: AppUser;
let accountId: string;

/**
 * A Worker who owns nothing, for the ownership refusals.
 *
 * A real v4 UUID, not a decorative one. Zod 4's `uuid()` validates the version
 * nibble, so an id like `0000…00cc` is rejected as malformed input before any
 * permission check runs — which would make a permission test pass for the wrong
 * reason.
 */
const STRANGER_ID = "3f1a2b4c-5d6e-4f70-8a91-b2c3d4e5f607";

const createdProblemIds: string[] = [];

beforeAll(async () => {
  if (!configured) {
    return;
  }

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const workers = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users where role = 'worker' and deleted_at is null limit 1
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
        id: "00000000-0000-0000-0000-0000000000bb",
        email: "worker@example.invalid",
        displayName: "Worker",
        initials: "WK",
        role: "worker",
      };

  /* A throwaway account, so nothing real is ever blocked by these tests. */
  const account = await sql!<{ id: string }[]>`
    insert into public.accounts (email, password_encrypted, status)
    values (${`m08-test-${Date.now()}@example.invalid`}, 'test-ciphertext', 'healthy')
    returning id
  `;

  accountId = account[0]!.id;
});

afterAll(async () => {
  if (!configured) {
    return;
  }

  /* Problems cascade with the account; the account is removed explicitly. */
  if (accountId) {
    await sql!`delete from public.accounts where id = ${accountId}::uuid`;
  }

  await sql!.end({ timeout: 5 });
});

async function services() {
  const { problemsService } = await import("@/modules/problems/services/problems.service");
  const { problemAssignmentService } =
    await import("@/modules/problems/services/problem-assignment.service");
  const { problemResolutionService } =
    await import("@/modules/problems/services/problem-resolution.service");
  const { problemTimelineService } =
    await import("@/modules/problems/services/problem-timeline.service");

  return {
    problemsService,
    problemAssignmentService,
    problemResolutionService,
    problemTimelineService,
  };
}

async function reportProblem(actor: AppUser = superAdmin, severity = "high") {
  const { problemsService } = await services();

  const result = await problemsService.report(
    {
      accountId,
      issueType: "payment_problem",
      severity,
      description: "Card declined during the monthly renewal attempt.",
      assignToMe: false,
    },
    { actor },
  );

  if (result.ok) {
    createdProblemIds.push(result.value.id);
  }

  return result;
}

describe.skipIf(!configured)("schema — migration 0008 applied", () => {
  it("created both tables with RLS enabled", async () => {
    const rows = await sql!<{ tablename: string; rowsecurity: boolean }[]>`
      select tablename, rowsecurity from pg_tables
      where schemaname = 'public' and tablename in ('issues', 'issue_notes')
    `;

    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(row.rowsecurity, `${row.tablename} has RLS off`).toBe(true);
    }
  });

  it("has policies on both tables", async () => {
    const rows = await sql!<{ tablename: string }[]>`
      select tablename from pg_policies
      where schemaname = 'public' and tablename in ('issues', 'issue_notes')
    `;

    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it("offers exactly the documented problem types", async () => {
    const rows = await sql!<{ label: string }[]>`
      select enumlabel as label from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'issue_type'
    `;

    expect(new Set(rows.map((row) => row.label))).toEqual(
      new Set([
        "payment_problem",
        "incorrect_password",
        "invalid_email",
        "something_went_wrong",
        "other",
      ]),
    );
  });

  it("lets audit_logs name a problem", async () => {
    const rows = await sql!<{ label: string }[]>`
      select enumlabel as label from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'audit_entity'
    `;

    expect(rows.map((row) => row.label)).toContain("issue");
  });

  it("refuses a resolved problem with no resolution note", async () => {
    /* The check constraint, independent of any service. */
    await expect(
      sql!`
        insert into public.issues (account_id, issue_type, status, description)
        values (${accountId}::uuid, 'other', 'resolved', 'no note provided')
      `,
    ).rejects.toThrow();
  });
});

describe.skipIf(!configured)("reporting", () => {
  it("creates a problem and writes an audit entry", async () => {
    const result = await reportProblem();

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.status).toBe("open");
      expect(result.value.reopenCount).toBe(0);
      expect(result.value.reportedBy).toBe(superAdmin.id);

      const audit = await sql!<{ n: number }[]>`
        select count(*)::int as n from public.audit_logs
        where entity = 'issue' and entity_id = ${result.value.id}::uuid and action = 'create'
      `;

      expect(audit[0]!.n).toBe(1);
    }
  });

  /*
   * M03 replaced "refuses a description that says nothing": a report now needs
   * only the account and the type. Severity and description are defaulted,
   * not required — and still validated when sent.
   */
  it("accepts a report with no severity or description, storing the defaults", async () => {
    const { problemsService } = await services();

    const result = await problemsService.report(
      { accountId, issueType: "other" },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      /* Resolved with the rest in "unblocks the account once every problem is finished". */
      createdProblemIds.push(result.value.id);
      expect(result.value.severity).toBe("medium");
      expect(result.value.description).toBe("");
    }
  });

  it("still refuses a severity that is not one of the four", async () => {
    const { problemsService } = await services();

    const result = await problemsService.report(
      { accountId, issueType: "other", severity: "urgent" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
  });

  it("lets a Worker report", async () => {
    const result = await reportProblem(worker, "medium");
    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
  });
});

describe.skipIf(!configured)("account health integration", () => {
  it("blocks every profile on the account while a problem is open", async () => {
    const { problemsService } = await services();

    const active = await problemsService.activeForAccount(accountId);

    expect(active.ok).toBe(true);
    if (active.ok) expect(active.value.length).toBeGreaterThan(0);

    const { accountsService } = await import("@/modules/accounts");
    const detail = await accountsService.getAccountDetail(accountId);

    expect(detail.ok, detail.ok ? "" : String(detail.error)).toBe(true);

    if (detail.ok) {
      /*
       * accounts.status is still 'healthy' — problems never write it. The
       * refusal comes from the computed conjunction, ADR-010 Decision 4.
       */
      expect(detail.value.account.status).toBe("healthy");
      expect(detail.value.accountAllowsAllocation).toBe(false);
      expect(detail.value.activeProblems.length).toBeGreaterThan(0);
    }
  });

  it("reports the account as carrying a problem in the grouped read", async () => {
    const { problemsService } = await services();

    const result = await problemsService.accountsWithActiveProblems([accountId]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.has(accountId)).toBe(true);
  });

  it("keeps Quick Prepare from offering the account", async () => {
    /*
     * The allocation query filters in SQL, so this asserts the NOT EXISTS
     * clause rather than a service-level filter.
     */
    const rows = await sql!<{ n: number }[]>`
      select count(*)::int as n
      from public.profiles p
      join public.accounts a on a.id = p.account_id
      where p.account_id = ${accountId}::uuid
        and p.status = 'available'
        and a.status = 'healthy'
        and a.deleted_at is null
        and not exists (
          select 1 from public.issues i
          where i.account_id = a.id and i.status in ('open', 'in_progress', 'waiting')
        )
    `;

    expect(rows[0]!.n).toBe(0);
  });
});

describe.skipIf(!configured)("assignment", () => {
  it("lets a Worker claim an unassigned problem", async () => {
    const { problemAssignmentService } = await services();
    const problemId = createdProblemIds[0]!;

    const result = await problemAssignmentService.claim(problemId, { actor: worker });

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    if (result.ok) expect(result.value.assignedTo).toBe(worker.id);
  });

  it("refuses a Worker taking a problem assigned to somebody else", async () => {
    const { problemAssignmentService } = await services();
    const problemId = createdProblemIds[0]!;

    const stranger: AppUser = { ...worker, id: STRANGER_ID };
    const result = await problemAssignmentService.assign(
      problemId,
      { assignedTo: stranger.id },
      { actor: stranger },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("lets a Super Admin reassign anything", async () => {
    const { problemAssignmentService } = await services();
    const problemId = createdProblemIds[0]!;

    const result = await problemAssignmentService.assign(
      problemId,
      { assignedTo: superAdmin.id },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    if (result.ok) expect(result.value.assignedTo).toBe(superAdmin.id);
  });
});

describe.skipIf(!configured)("ownership — mutability is assignment-based", () => {
  it("refuses a Worker updating a problem they do not own", async () => {
    const { problemsService } = await services();
    const problemId = createdProblemIds[0]!;

    const result = await problemsService.update(
      problemId,
      { status: "in_progress" },
      { actor: worker },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("refuses a Worker changing severity even on their own problem", async () => {
    const { problemsService, problemAssignmentService } = await services();
    const problemId = createdProblemIds[1]!;

    await problemAssignmentService.assign(
      problemId,
      { assignedTo: worker.id },
      { actor: superAdmin },
    );

    const result = await problemsService.update(
      problemId,
      { severity: "critical" },
      { actor: worker },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("refuses a Worker deleting anything", async () => {
    const { problemsService } = await services();

    const result = await problemsService.remove(createdProblemIds[0]!, { actor: worker });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ForbiddenError);
  });

  it("still lets every signed-in role SEE every problem", async () => {
    const { problemsService } = await services();

    const result = await problemsService.list({ limit: 25, offset: 0 }, worker);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    if (result.ok) expect(result.value.total).toBeGreaterThan(0);
  });
});

describe.skipIf(!configured)("transitions", () => {
  it("refuses an illegal jump from open to closed", async () => {
    const { problemsService } = await services();

    const result = await problemsService.update(
      createdProblemIds[0]!,
      { status: "closed" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Illegal transition");
  });

  it("sends resolve through the resolution service rather than update", async () => {
    const { problemsService } = await services();

    const result = await problemsService.update(
      createdProblemIds[0]!,
      { status: "resolved" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain("Resolve");
  });

  it("moves open to in progress", async () => {
    const { problemsService } = await services();

    const result = await problemsService.update(
      createdProblemIds[0]!,
      { status: "in_progress" },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    if (result.ok) expect(result.value.status).toBe("in_progress");
  });
});

describe.skipIf(!configured)("resolution and reopening", () => {
  it("refuses to resolve without a note", async () => {
    const { problemResolutionService } = await services();

    const result = await problemResolutionService.resolve(
      createdProblemIds[0]!,
      { resolutionNote: "" },
      { actor: superAdmin },
    );

    expect(result.ok).toBe(false);
  });

  it("resolves with a note and records who and when", async () => {
    const { problemResolutionService } = await services();

    const result = await problemResolutionService.resolve(
      createdProblemIds[0]!,
      { resolutionNote: "Card updated by the customer; renewal succeeded on retry." },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.status).toBe("resolved");
      expect(result.value.resolvedBy).toBe(superAdmin.id);
      expect(result.value.resolvedAt).toBeInstanceOf(Date);
      expect(result.value.resolutionNote).toContain("Card updated");
    }
  });

  it("unblocks the account once every problem is finished", async () => {
    const { problemResolutionService } = await services();

    /* Resolve the rest, so nothing is left blocking. */
    for (const id of createdProblemIds.slice(1)) {
      await problemResolutionService.resolve(
        id,
        { resolutionNote: "Closed out as part of the M08 verification run." },
        { actor: superAdmin },
      );
    }

    const { accountsService } = await import("@/modules/accounts");
    const detail = await accountsService.getAccountDetail(accountId);

    expect(detail.ok).toBe(true);

    if (detail.ok) {
      expect(detail.value.activeProblems).toHaveLength(0);
      expect(detail.value.accountAllowsAllocation).toBe(true);
    }
  });

  it("reopens, increments the counter and clears the stale resolution", async () => {
    const { problemResolutionService } = await services();

    const result = await problemResolutionService.reopen(
      createdProblemIds[0]!,
      { reason: "Payment failed again on the next cycle." },
      { actor: superAdmin },
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      expect(result.value.status).toBe("open");
      expect(result.value.reopenCount).toBe(1);
      /* A row must never claim a resolution that demonstrably did not hold. */
      expect(result.value.resolutionNote).toBeNull();
      expect(result.value.resolvedAt).toBeNull();
    }
  });

  it("blocks the account again after the reopen", async () => {
    const { accountsService } = await import("@/modules/accounts");
    const detail = await accountsService.getAccountDetail(accountId);

    expect(detail.ok).toBe(true);
    if (detail.ok) expect(detail.value.accountAllowsAllocation).toBe(false);
  });
});

describe.skipIf(!configured)("timeline and notes", () => {
  it("builds a timeline from audit entries and notes, without a third table", async () => {
    const { problemTimelineService } = await services();

    const result = await problemTimelineService.forProblem(createdProblemIds[0]!, superAdmin);

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);

    if (result.ok) {
      const kinds = result.value.map((entry) => entry.kind);

      expect(kinds).toContain("created");
      expect(kinds).toContain("reopened");

      /* Newest first. */
      const times = result.value.map((entry) => entry.createdAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    }
  });

  it("appends a note and refuses one from a non-owner", async () => {
    const { problemTimelineService } = await services();
    const problemId = createdProblemIds[0]!;

    const mine = await problemTimelineService.addNote(
      problemId,
      { body: "Chased the customer about the card." },
      { actor: superAdmin },
    );

    expect(mine.ok, mine.ok ? "" : String(mine.error)).toBe(true);

    const stranger: AppUser = { ...worker, id: STRANGER_ID };
    const theirs = await problemTimelineService.addNote(
      problemId,
      { body: "Should not be allowed." },
      { actor: stranger },
    );

    expect(theirs.ok).toBe(false);
  });

  it("has no update path for a note", async () => {
    /* Append-only by construction: the table carries no updated_at at all. */
    const rows = await sql!<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'issue_notes'
    `;

    expect(rows.map((row) => row.column_name)).not.toContain("updated_at");
  });
});

describe.skipIf(!configured)("search and filtering", () => {
  it("finds a problem by account email", async () => {
    const { problemsService } = await services();

    const account = await sql!<{ email: string }[]>`
      select email from public.accounts where id = ${accountId}::uuid
    `;

    const result = await problemsService.list(
      { search: account[0]!.email, limit: 25, offset: 0 },
      superAdmin,
    );

    expect(result.ok, result.ok ? "" : String(result.error)).toBe(true);
    if (result.ok) expect(result.value.total).toBeGreaterThan(0);
  });

  it("filters by status and severity without error", async () => {
    const { problemsService } = await services();

    const open = await problemsService.list({ status: "open", limit: 10, offset: 0 }, superAdmin);
    const critical = await problemsService.list(
      { severity: "critical", limit: 10, offset: 0 },
      superAdmin,
    );

    expect(open.ok).toBe(true);
    expect(critical.ok).toBe(true);

    if (open.ok) {
      for (const entry of open.value.items) {
        expect(entry.problem.status).toBe("open");
      }
    }
  });

  it("paginates", async () => {
    const { problemsService } = await services();

    const result = await problemsService.list({ limit: 1, offset: 0 }, superAdmin);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items.length).toBeLessThanOrEqual(1);
  });
});
