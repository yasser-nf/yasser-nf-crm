import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";
import { describeDatabaseUrl } from "../support/database-target.mjs";

/**
 * M05 notifications, against the isolated database.
 *
 * Notifications are created by the real Problems services — report, assign,
 * resolve, reopen, delete — and read and marked through the real
 * notifications service, so each test checks rows: who received what, what it
 * says, and that nobody can read or mark anybody else's.
 *
 * LOCAL ONLY.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const local = describeDatabaseUrl(DATABASE_URL)?.isLocal === true;

const sql = local ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const ADMIN_2 = "00000000-0000-4000-8000-0000000000a2";
const SUSPENDED_ADMIN = "00000000-0000-4000-8000-0000000000a3";
const ARCHIVED_ADMIN = "00000000-0000-4000-8000-0000000000a4";
const WORKER_2 = "00000000-0000-4000-8000-0000000000b2";

/** Free text that must never be copied into anybody's notifications. */
const SECRET_DESCRIPTION = "customer says the password is Hunter2-SECRET";
const SECRET_NOTE = "Reset the password to Swordfish-SECRET and verified login.";

let admin: AppUser;
let admin2: AppUser;
let worker: AppUser;
let worker2: AppUser;

function appUser(id: string, name: string, role: AppUser["role"]): AppUser {
  return { id, email: `${id}@test.invalid`, displayName: name, initials: "T", role };
}

async function services() {
  const { accountsService } = await import("@/modules/accounts");
  const {
    problemsService,
    problemAssignmentService,
    problemResolutionService,
    bulkProblemsService,
  } = await import("@/modules/problems");
  const { notificationsService } = await import("@/modules/notifications");
  return {
    accountsService,
    problemsService,
    problemAssignmentService,
    problemResolutionService,
    bulkProblemsService,
    notificationsService,
  };
}

let counter = 0;
const TAG = `nt${Date.now() % 100000}`;

async function makeAccount(): Promise<{ id: string; email: string }> {
  const { accountsService } = await services();
  counter += 1;
  const email = `${TAG}-${counter}@example.invalid`;
  const created = await accountsService.createAccount(
    { email, password: "not-a-real-password", country: "DZ", profileSlots: 5 },
    { actor: admin },
  );
  if (!created.ok) throw new Error(created.error.message);
  return { id: created.value.id, email };
}

async function report(accountId: string, actor: AppUser): Promise<string> {
  const { problemsService } = await services();
  const created = await problemsService.report(
    { accountId, issueType: "payment_problem", description: SECRET_DESCRIPTION },
    { actor },
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value.id;
}

interface Row {
  recipient_id: string;
  actor_id: string | null;
  type: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read_at: Date | null;
}

async function notificationsFor(problemId: string): Promise<Row[]> {
  return sql!<Row[]>`
    select recipient_id, actor_id, type, title, body, entity_type, entity_id, read_at
    from notifications where entity_id = ${problemId}::uuid order by created_at, recipient_id`;
}

function recipients(rows: readonly Row[], type: string): string[] {
  return rows
    .filter((row) => row.type === type)
    .map((row) => row.recipient_id)
    .sort();
}

beforeAll(async () => {
  if (!local) return;

  const [seedAdmin] = await sql!<{ id: string }[]>`
    select id from users where role = 'super_admin' and deleted_at is null limit 1`;
  const [seedWorker] = await sql!<{ id: string }[]>`
    select id from users where role = 'worker' and deleted_at is null limit 1`;

  await sql!`
    insert into auth.users (id, email) values
      (${ADMIN_2}, 'admin2@test.invalid'), (${SUSPENDED_ADMIN}, 'suspended@test.invalid'),
      (${ARCHIVED_ADMIN}, 'archived@test.invalid'), (${WORKER_2}, 'worker2@test.invalid')
    on conflict (id) do nothing`;
  await sql!`
    insert into public.users (id, name, email, role, status, deleted_at) values
      (${ADMIN_2}, 'Second Admin', 'admin2@test.invalid', 'super_admin', 'active', null),
      (${SUSPENDED_ADMIN}, 'Suspended Admin', 'suspended@test.invalid', 'super_admin', 'suspended', null),
      (${ARCHIVED_ADMIN}, 'Archived Admin', 'archived@test.invalid', 'super_admin', 'active', now()),
      (${WORKER_2}, 'Second Worker', 'worker2@test.invalid', 'worker', 'active', null)
    on conflict (id) do nothing`;

  admin = appUser(seedAdmin!.id, "Test Super Admin", "super_admin");
  admin2 = appUser(ADMIN_2, "Second Admin", "super_admin");
  worker = appUser(seedWorker!.id, "Test Worker", "worker");
  worker2 = appUser(WORKER_2, "Second Worker", "worker");
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/* ------------------------------------------------------------------ creation */

describe.skipIf(!local)("notification creation from problem events", () => {
  it("a reported problem notifies every ACTIVE Super Admin, never the reporter", async () => {
    const account = await makeAccount();
    const problem = await report(account.id, worker);
    const rows = await notificationsFor(problem);

    expect(recipients(rows, "problem_reported")).toEqual([admin.id, ADMIN_2].sort());
    /* Not the suspended admin, not the archived one, not the Worker who reported it. */
    expect(rows.map((row) => row.recipient_id)).not.toContain(SUSPENDED_ADMIN);
    expect(rows.map((row) => row.recipient_id)).not.toContain(ARCHIVED_ADMIN);
    expect(rows.map((row) => row.recipient_id)).not.toContain(worker.id);

    const one = rows[0]!;
    expect(one.title).toBe("New problem: Payment problem");
    expect(one.body).toContain(account.email);
    expect(one.body).toContain("Test Worker");
    expect(one.entity_type).toBe("issue");
    expect(one.actor_id).toBe(worker.id);
    expect(one.read_at).toBeNull();
  });

  it("a Super Admin reporting is not notified of their own report", async () => {
    const account = await makeAccount();
    const problem = await report(account.id, admin);

    expect(recipients(await notificationsFor(problem), "problem_reported")).toEqual([ADMIN_2]);
  });

  it("assignment notifies the new assignee; claiming for oneself notifies nobody", async () => {
    const { problemAssignmentService } = await services();
    const account = await makeAccount();
    const assignedByAdmin = await report(account.id, admin);

    const assigned = await problemAssignmentService.assign(
      assignedByAdmin,
      { assignedTo: worker.id },
      { actor: admin },
    );
    expect(assigned.ok).toBe(true);
    expect(recipients(await notificationsFor(assignedByAdmin), "problem_assigned")).toEqual([
      worker.id,
    ]);

    const claimed = await report(account.id, admin);
    const claim = await problemAssignmentService.claim(claimed, { actor: worker });
    expect(claim.ok).toBe(true);
    expect(recipients(await notificationsFor(claimed), "problem_assigned")).toEqual([]);
  });

  it("reassigning to the same person later is a new event, not a duplicate", async () => {
    const { problemAssignmentService } = await services();
    const account = await makeAccount();
    const problem = await report(account.id, admin);

    await problemAssignmentService.assign(problem, { assignedTo: worker.id }, { actor: admin });
    await problemAssignmentService.assign(problem, { assignedTo: worker2.id }, { actor: admin });
    await problemAssignmentService.assign(problem, { assignedTo: worker.id }, { actor: admin });
    /* An unchanged assignment is a no-op and notifies nobody. */
    await problemAssignmentService.assign(problem, { assignedTo: worker.id }, { actor: admin });

    expect(recipients(await notificationsFor(problem), "problem_assigned")).toEqual(
      [worker.id, worker.id, WORKER_2].sort(),
    );
  });

  it("resolution notifies the reporter and the assignee, not the resolver", async () => {
    const { problemAssignmentService, problemResolutionService } = await services();
    const account = await makeAccount();
    const problem = await report(account.id, worker2);
    await problemAssignmentService.assign(problem, { assignedTo: worker.id }, { actor: admin });

    const resolved = await problemResolutionService.resolve(
      problem,
      { resolutionNote: SECRET_NOTE },
      { actor: admin },
    );
    expect(resolved.ok).toBe(true);

    const rows = await notificationsFor(problem);
    expect(recipients(rows, "problem_resolved")).toEqual([worker.id, WORKER_2].sort());
    expect(rows.find((row) => row.type === "problem_resolved")?.title).toBe(
      "Resolved: Payment problem",
    );
  });

  it("a Worker resolving their own assigned problem notifies the reporter only", async () => {
    const { problemAssignmentService, problemResolutionService } = await services();
    const account = await makeAccount();
    const problem = await report(account.id, admin);
    await problemAssignmentService.claim(problem, { actor: worker });

    await problemResolutionService.resolve(
      problem,
      { resolutionNote: "Payment method updated with the customer." },
      { actor: worker },
    );

    expect(recipients(await notificationsFor(problem), "problem_resolved")).toEqual([admin.id]);
  });

  it("reopening notifies the assignee", async () => {
    const { problemAssignmentService, problemResolutionService } = await services();
    const account = await makeAccount();
    const problem = await report(account.id, admin);
    await problemAssignmentService.assign(problem, { assignedTo: worker.id }, { actor: admin });
    await problemResolutionService.resolve(
      problem,
      { resolutionNote: "Payment method updated with the customer." },
      { actor: admin },
    );

    const reopened = await problemResolutionService.reopen(
      problem,
      { reason: "The payment failed again this morning." },
      { actor: admin },
    );
    expect(reopened.ok).toBe(true);
    expect(recipients(await notificationsFor(problem), "problem_reopened")).toEqual([worker.id]);
  });

  it("bulk resolution notifies through the same single-problem path", async () => {
    const { bulkProblemsService } = await services();
    const account = await makeAccount();
    const one = await report(account.id, worker);
    const two = await report(account.id, worker);

    const outcome = await bulkProblemsService.resolveProblems(
      [one, two],
      { resolutionNote: "Both fixed together during the sweep." },
      { actor: admin },
    );
    expect(outcome.ok).toBe(true);

    expect(recipients(await notificationsFor(one), "problem_resolved")).toEqual([worker.id]);
    expect(recipients(await notificationsFor(two), "problem_resolved")).toEqual([worker.id]);
  });

  it("no notification ever carries the description or the resolution note", async () => {
    const [leaks] = await sql!<{ n: number }[]>`
      select count(*)::int n from notifications
      where title ilike '%SECRET%' or body ilike '%SECRET%'
         or title ilike '%password is%' or body ilike '%Swordfish%'`;

    expect(leaks?.n).toBe(0);
  });

  it("deleting a problem removes the notifications that would link to it", async () => {
    const { problemsService } = await services();
    const account = await makeAccount();
    const problem = await report(account.id, worker);
    expect((await notificationsFor(problem)).length).toBeGreaterThan(0);

    const removed = await problemsService.remove(problem, { actor: admin });
    expect(removed.ok).toBe(true);
    expect(await notificationsFor(problem)).toEqual([]);
  });
});

/* ------------------------------------------------------------ deduplication */

describe.skipIf(!local)("duplicate prevention", () => {
  it("the same event key twice for the same people is one notification each", async () => {
    const { notificationsService } = await services();
    const account = await makeAccount();
    const problem = await report(account.id, admin);
    const event = {
      type: "problem_reopened" as const,
      recipients: { userIds: [worker.id, WORKER_2] },
      actor: admin,
      title: "Reopened: Payment problem",
      entity: { type: "issue" as const, id: problem },
      dedupeKey: `test-retry:${problem}`,
    };

    const first = await notificationsService.notify(event);
    const retry = await notificationsService.notify(event);

    expect(first.ok && first.value).toBe(2);
    expect(retry.ok && retry.value).toBe(0);
    expect(recipients(await notificationsFor(problem), "problem_reopened")).toEqual(
      [worker.id, WORKER_2].sort(),
    );
  });
});

/* ---------------------------------------------- reading, marking, isolation */

describe.skipIf(!local)("the notification center: counts, marking and isolation", () => {
  async function unreadInDb(userId: string): Promise<number> {
    const [row] = await sql!<{ n: number }[]>`
      select count(*)::int n from notifications where recipient_id = ${userId}::uuid and read_at is null`;
    return row?.n ?? 0;
  }

  it("the summary holds only the caller's notifications, with an exact unread count", async () => {
    const { notificationsService } = await services();
    const account = await makeAccount();
    await report(account.id, worker2);

    const summary = await notificationsService.summary(admin2);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;

    const [owned] = await sql!<{ n: number }[]>`
      select count(*)::int n from notifications where recipient_id = ${ADMIN_2}::uuid`;
    const ids = summary.value.items.map((item) => item.id);
    const [foreign] = await sql!<{ n: number }[]>`
      select count(*)::int n from notifications
      where id = any(${ids}::uuid[]) and recipient_id <> ${ADMIN_2}::uuid`;

    expect(foreign?.n).toBe(0);
    expect(summary.value.items.length).toBe(Math.min(owned!.n, 20));
    expect(summary.value.unreadCount).toBe(await unreadInDb(ADMIN_2));
    expect(summary.value.items[0]?.href).toMatch(/^\/problems\/[0-9a-f-]{36}$/);
  });

  it("marks one read, idempotently; the count follows", async () => {
    const { notificationsService } = await services();
    const account = await makeAccount();
    const problem = await report(account.id, worker);
    const [mine] = await sql!<{ id: string }[]>`
      select id from notifications where entity_id = ${problem}::uuid and recipient_id = ${ADMIN_2}::uuid`;
    const before = await unreadInDb(ADMIN_2);

    const first = await notificationsService.markRead(mine!.id, admin2);
    const again = await notificationsService.markRead(mine!.id, admin2);

    expect(first.ok && first.value).toBe(true);
    expect(again.ok && again.value).toBe(false);
    expect(await unreadInDb(ADMIN_2)).toBe(before - 1);

    const summary = await notificationsService.summary(admin2);
    expect(summary.ok && summary.value.items.find((item) => item.id === mine!.id)?.read).toBe(true);
  });

  it("cannot mark another person's notification read — and learns nothing about it", async () => {
    const { notificationsService } = await services();
    const account = await makeAccount();
    const problem = await report(account.id, worker);
    const [theirs] = await sql!<{ id: string }[]>`
      select id from notifications where entity_id = ${problem}::uuid and recipient_id = ${admin.id}::uuid`;

    const attempt = await notificationsService.markRead(theirs!.id, worker2);

    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe("NOT_FOUND");

    const [row] = await sql!<{ read_at: Date | null }[]>`
      select read_at from notifications where id = ${theirs!.id}::uuid`;
    expect(row?.read_at).toBeNull();
  });

  it("mark all read touches only the caller's rows", async () => {
    const { notificationsService } = await services();
    const account = await makeAccount();
    await report(account.id, worker);
    const adminUnreadBefore = await unreadInDb(admin.id);
    expect(await unreadInDb(ADMIN_2)).toBeGreaterThan(0);

    const marked = await notificationsService.markAllRead(admin2);

    expect(marked.ok && marked.value).toBeGreaterThan(0);
    expect(await unreadInDb(ADMIN_2)).toBe(0);
    expect(await unreadInDb(admin.id)).toBe(adminUnreadBefore);

    const summary = await notificationsService.summary(admin2);
    expect(summary.ok && summary.value.unreadCount).toBe(0);
  });

  it("someone with no notifications gets an empty list and zero — a real empty state", async () => {
    const { notificationsService } = await services();
    const nobody = appUser(SUSPENDED_ADMIN, "Suspended Admin", "super_admin");

    const summary = await notificationsService.summary(nobody);

    expect(summary.ok && summary.value).toEqual({ items: [], unreadCount: 0 });
  });

  it("refuses the signed-out and a malformed id", async () => {
    const { notificationsService } = await services();

    const anonymous = await notificationsService.summary(null);
    const markAnonymous = await notificationsService.markAllRead(null);
    const malformed = await notificationsService.markRead("not-a-uuid", worker);

    expect(anonymous.ok).toBe(false);
    expect(markAnonymous.ok).toBe(false);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("VALIDATION_ERROR");
  });
});

/* ------------------------------------------------------------ database layer */

describe.skipIf(!local)("the table protects itself", () => {
  it("has RLS on, grants nothing to browser roles, and only a read-own policy", async () => {
    const [table] = await sql!<{ rls: boolean }[]>`
      select relrowsecurity as rls from pg_class where oid = 'public.notifications'::regclass`;
    const grants = await sql!<{ grantee: string }[]>`
      select grantee from information_schema.role_table_grants
      where table_name = 'notifications' and grantee in ('anon', 'authenticated')`;
    const policies = await sql!<{ cmd: string }[]>`
      select cmd from pg_policies where tablename = 'notifications'`;

    expect(table?.rls).toBe(true);
    expect(grants).toEqual([]);
    expect(policies.map((policy) => policy.cmd)).toEqual(["SELECT"]);
  });

  it("rejects an unknown type and a duplicate event key at the database", async () => {
    await expect(sql!`
      insert into notifications (recipient_id, type, title, dedupe_key)
      values (${admin.id}::uuid, 'made_up', 'x', 'k1')`).rejects.toThrow();

    await sql!`
      insert into notifications (recipient_id, type, title, dedupe_key)
      values (${admin.id}::uuid, 'problem_reported', 'x', 'dup-key')`;
    await expect(sql!`
      insert into notifications (recipient_id, type, title, dedupe_key)
      values (${admin.id}::uuid, 'problem_reported', 'x', 'dup-key')`).rejects.toThrow();
  });
});
