import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConflictError,
  DatabaseError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  UnexpectedError,
  ValidationError,
} from "@/lib/errors";
import { requestHash } from "@/modules/idempotency";
import {
  assertSafePayload,
  createRegistry,
  defineJob,
} from "@/modules/jobs/services/job-definition";
import { JobRetryableError, classifyFailure } from "@/modules/jobs/services/job-errors";
import {
  JOB_STATUSES,
  TERMINAL_STATUSES,
  canTransition,
  displayState,
  priorityName,
  retryDelaySeconds,
  transitionFor,
  type JobTransitionCause,
} from "@/modules/jobs/services/job-states";
import {
  invertedRange,
  parseJobsFilter,
  toJobListItem,
  toRepositoryFilter,
} from "@/modules/jobs/services/job-view";
import { ok } from "@/utils/result";

/**
 * M08 jobs, without a database: the lifecycle's rules, retry backoff, how a
 * failure is classified and what of it is kept, payload screening, request
 * hashing for idempotency, and the shape that reaches the browser.
 */

describe("the lifecycle", () => {
  it("allows exactly the documented moves", () => {
    const allowed: Record<JobTransitionCause, string> = {
      claim: "queued→running",
      heartbeat: "running→running",
      complete: "running→succeeded",
      retry: "running→queued",
      fail: "running→failed",
      cancel: "queued→cancelled",
      recover_requeue: "running→queued",
      recover_fail: "running→failed",
      recover_completed: "running→succeeded",
    };

    for (const [cause, move] of Object.entries(allowed) as [JobTransitionCause, string][]) {
      expect(transitionFor(cause).join("→")).toBe(move);
      for (const from of JOB_STATUSES) {
        expect(canTransition(from, cause)).toBe(move.startsWith(`${from}→`));
      }
    }
  });

  it("lets nothing leave a terminal status, and never cancels a running job", () => {
    const causes = Object.keys({
      claim: 0,
      heartbeat: 0,
      complete: 0,
      retry: 0,
      fail: 0,
      cancel: 0,
      recover_requeue: 0,
      recover_fail: 0,
      recover_completed: 0,
    }) as JobTransitionCause[];

    for (const terminal of TERMINAL_STATUSES) {
      for (const cause of causes) expect(canTransition(terminal, cause)).toBe(false);
    }
    expect(canTransition("running", "cancel")).toBe(false);
  });

  it("derives what a Super Admin sees: retrying and stale are views, not statuses", () => {
    const now = new Date("2026-06-17T10:30:00Z");
    const heartbeat = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000);

    expect(displayState({ status: "queued", attempts: 0, heartbeatAt: null }, now)).toBe("queued");
    expect(displayState({ status: "queued", attempts: 1, heartbeatAt: null }, now)).toBe(
      "retrying",
    );
    expect(displayState({ status: "running", attempts: 1, heartbeatAt: heartbeat(20) }, now)).toBe(
      "running",
    );
    expect(displayState({ status: "running", attempts: 1, heartbeatAt: heartbeat(301) }, now)).toBe(
      "stale",
    );
    expect(displayState({ status: "failed", attempts: 3, heartbeatAt: null }, now)).toBe("failed");
  });

  it("backs off 30 s, 1 min, 2 min … and stops growing at 15 min", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(retryDelaySeconds)).toEqual([
      30, 60, 120, 240, 480, 900, 900, 900,
    ]);
    expect(retryDelaySeconds(0)).toBe(30);
  });

  it("names the three priorities", () => {
    expect([10, 0, -10, 5].map(priorityName)).toEqual(["urgent", "normal", "low", "custom"]);
  });
});

describe("classifying a failure", () => {
  it("retries what is transient", () => {
    const transient = [
      new JobRetryableError("worker timeout"),
      new ExternalServiceError("storage down"),
      new DatabaseError("pooler dropped", { context: { sqlState: "08006" } }),
      new DatabaseError("deadlock", { context: { sqlState: "40P01" } }),
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    ];

    for (const error of transient)
      expect(classifyFailure(error).retryable, String(error)).toBe(true);
  });

  it("never retries what is the answer", () => {
    const permanent = [
      new ValidationError("profile already sold"),
      new ConflictError("account unavailable"),
      new NotFoundError("customer gone"),
      new ForbiddenError("not permitted"),
      new DatabaseError("constraint", { context: { sqlState: "23514" } }),
      new UnexpectedError("bug"),
      new Error("handler bug"),
    ];

    for (const error of permanent)
      expect(classifyFailure(error).retryable, String(error)).toBe(false);
  });

  it("keeps only a safe summary — never the raw message", () => {
    const leaky = new Error("decrypt failed for PIN 4321 with key sk_live_abcdef123456");
    const summary = classifyFailure(leaky);

    expect(summary.code).toBe("UNEXPECTED_ERROR");
    expect(summary.message).not.toMatch(/4321|sk_live|decrypt/);

    const wrapped = new DatabaseError("Failed query: update … params: 4321,secret", {
      context: { sqlState: "08006" },
    });
    expect(classifyFailure(wrapped).message).not.toMatch(/4321|secret|params/);
    expect(classifyFailure(wrapped).message).toBe(wrapped.userMessage);
  });
});

describe("job payloads carry references, not credentials", () => {
  it("accepts ids and plain facts", () => {
    expect(() =>
      assertSafePayload({
        accountId: "aaaaaaaa-0000-4000-8000-000000000001",
        profileIds: ["bbbbbbbb-0000-4000-8000-000000000001"],
        durationDays: 30,
        nested: { customerId: "cccccccc-0000-4000-8000-000000000001" },
      }),
    ).not.toThrow();
  });

  it.each([
    [{ password: "x" }],
    [{ pin: "1234" }],
    [{ nested: { accessToken: "x" } }],
    [{ list: [{ apiKey: "x" }] }],
    [{ credentials: { secret: "x" } }],
    [{ accountId: "a", note: "v1:aGVsbG8:d29ybGQ:Zm9vYmFy" }],
  ])("refuses %j", (payload) => {
    expect(() => assertSafePayload(payload)).toThrow(ValidationError);
  });
});

describe("job types", () => {
  const echo = defineJob({
    type: "test.echo",
    payload: z.object({ n: z.number() }),
    async run(context) {
      return ok({ n: context.payload.n });
    },
  });

  it("validates the type name and attempt bound", () => {
    expect(() => defineJob({ ...echo, type: "Test Echo" })).toThrow();
    expect(() => defineJob({ ...echo, type: "a".repeat(65) })).toThrow();
    expect(() => defineJob({ ...echo, maxAttempts: 0 })).toThrow();
    expect(() => defineJob({ ...echo, maxAttempts: 21 })).toThrow();
  });

  it("refuses a registry that defines a type twice", () => {
    expect(() => createRegistry([echo, echo])).toThrow(/defined twice/);
    expect([...createRegistry([echo]).keys()]).toEqual(["test.echo"]);
  });
});

describe("request hashing for idempotency", () => {
  it("ignores key order and undefined fields, and nothing else", () => {
    expect(requestHash({ a: 1, b: [1, 2], c: undefined })).toBe(requestHash({ b: [1, 2], a: 1 }));
    expect(requestHash({ a: 1, b: [1, 2] })).not.toBe(requestHash({ a: 1, b: [2, 1] }));
    expect(requestHash({ a: "1" })).not.toBe(requestHash({ a: 1 }));
    expect(requestHash({ a: { x: 1, y: 2 } })).toBe(requestHash({ a: { y: 2, x: 1 } }));
  });
});

describe("the jobs page filter", () => {
  it("keeps only what it recognises", () => {
    const parsed = parseJobsFilter({
      type: "netflix.verify_account",
      status: "running",
      from: "2026-06-01",
      to: "2026-02-30",
      search: "  abc  ",
      offset: "-5",
    });

    expect(parsed).toEqual({
      type: "netflix.verify_account",
      status: "running",
      from: "2026-06-01",
      to: undefined,
      search: "abc",
      offset: 0,
    });
    expect(parseJobsFilter({ type: "DROP TABLE", status: "stale" })).toMatchObject({
      type: undefined,
      status: undefined,
    });
  });

  it("searches an exact id, or escaped text — never raw wildcards", () => {
    const id = "aaaaaaaa-0000-4000-8000-000000000001";
    expect(toRepositoryFilter(parseJobsFilter({ search: id }))).toMatchObject({
      searchId: id,
      searchContains: undefined,
    });
    expect(toRepositoryFilter(parseJobsFilter({ search: "100%_x" }))).toMatchObject({
      searchId: undefined,
      searchContains: "%100\\%\\_x%",
    });
  });

  it("treats `to` as a whole UTC day, and an inverted range as a mistake", () => {
    const repo = toRepositoryFilter(parseJobsFilter({ from: "2026-06-01", to: "2026-06-02" }));
    expect(repo.createdFrom?.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(repo.createdBefore?.toISOString()).toBe("2026-06-03T00:00:00.000Z");
    expect(invertedRange(parseJobsFilter({ from: "2026-06-02", to: "2026-06-01" }))).toBe(true);
  });
});

describe("what reaches the browser", () => {
  it("never the payload, the result, the idempotency key or the claim token", () => {
    const row = {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      type: "test.echo",
      status: "running" as const,
      priority: 0,
      idempotencyKey: "secret-ish-key",
      payload: { accountId: "x" },
      result: { n: 1 },
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
      availableAt: new Date(),
      startedAt: new Date(),
      heartbeatAt: new Date(),
      finishedAt: null,
      cancelledAt: null,
      recoveredAt: null,
      claimedBy: "worker-1",
      claimToken: "dddddddd-0000-4000-8000-000000000001",
      lastError: null,
      lastErrorCode: null,
    };

    const item = toJobListItem(row, new Date());
    const serialized = JSON.stringify(item);

    expect(Object.keys(item)).not.toEqual(expect.arrayContaining(["payload"]));
    for (const forbidden of ["payload", "result", "idempotencyKey", "claimToken"]) {
      expect(item).not.toHaveProperty(forbidden);
    }
    expect(serialized).not.toContain("dddddddd-0000-4000-8000-000000000001");
    expect(serialized).not.toContain("secret-ish-key");
    expect(item.cancellable).toBe(false);
  });
});
