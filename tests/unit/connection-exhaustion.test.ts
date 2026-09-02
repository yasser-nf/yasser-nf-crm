import { describe, expect, it } from "vitest";

import { DatabaseError, ExternalServiceError, ForbiddenError, UnexpectedError } from "@/lib/errors";
import {
  CONNECT_TIMEOUT_SECONDS,
  IDLE_TIMEOUT_SECONDS,
  MAX_POOL_SIZE,
  POOLER_SESSION_LIMIT,
  SUPPORTED_CONCURRENT_INSTANCES,
  poolOptions,
} from "@/lib/drizzle/pool-config";
import { presentStock, type StockSummary } from "@/modules/dashboard";
import { fail, ok } from "@/utils/result";

/**
 * Regression tests for a production outage.
 *
 * The pool was sized as though one instance were the only client of the
 * database. It is not: Supavisor enforces a single project-wide budget of
 * `pool_size: 15`, and every warm serverless instance draws its own pool from
 * it. Two busy instances at `max: 10` asked for twenty of fifteen, and the
 * pooler refused the surplus with `XX000 EMAXCONNSESSION`.
 *
 * The rejection landed on whichever query ran first, which was almost always
 * the session lookup that precedes every request — so a connection shortage
 * appeared to operators as three unrelated bugs: an accounts page that would
 * not load, a dashboard claiming their unsaved changes were lost, and a widget
 * telling a Super Admin their role lacked access.
 *
 * Each block below pins one of those.
 */

describe("connection pool is sized against the pooler's budget", () => {
  it("leaves room for every instance that may run at once", () => {
    /*
     * The invariant the old configuration broke. It is the whole bug: 10 x 4
     * instances demands 40 connections from a pooler that grants 15, and the
     * surplus is refused rather than queued.
     */
    expect(MAX_POOL_SIZE * SUPPORTED_CONCURRENT_INSTANCES).toBeLessThanOrEqual(
      POOLER_SESSION_LIMIT,
    );
  });

  it("rejects the configuration that caused the outage", () => {
    /* Documents the failing arithmetic so the old value cannot quietly return. */
    const OUTAGE_POOL_SIZE = 10;

    expect(OUTAGE_POOL_SIZE * SUPPORTED_CONCURRENT_INSTANCES).toBeGreaterThan(POOLER_SESSION_LIMIT);
    expect(MAX_POOL_SIZE).toBeLessThan(OUTAGE_POOL_SIZE);
  });

  it("never lets a single instance exhaust the budget on its own", () => {
    expect(MAX_POOL_SIZE).toBeLessThan(POOLER_SESSION_LIMIT);
  });

  it("returns idle connections faster than an instance stays warm", () => {
    /*
     * An instance sitting on connections between requests is what turns a
     * generous pool into a shortage for its siblings.
     */
    expect(IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(10);
    expect(IDLE_TIMEOUT_SECONDS).toBeGreaterThan(0);
  });

  it("passes exactly these numbers to the driver", () => {
    /* The constants above are only meaningful if the client actually uses them. */
    expect(poolOptions.max).toBe(MAX_POOL_SIZE);
    expect(poolOptions.idle_timeout).toBe(IDLE_TIMEOUT_SECONDS);
    expect(poolOptions.connect_timeout).toBe(CONNECT_TIMEOUT_SECONDS);
  });

  it("still disables prepared statements for the pooler", () => {
    /* Unrelated to the outage, and a regression here would break every query. */
    expect(poolOptions.prepare).toBe(false);
  });
});

describe("a failed read does not claim a failed save", () => {
  it("does not tell the operator their changes were lost", () => {
    const error = new DatabaseError("connection pool exhausted");

    /*
     * The dashboard only reads. Showing "something went wrong while saving
     * your changes" there reported data loss that had not happened.
     */
    expect(error.userMessage).not.toMatch(/saving/i);
    expect(error.userMessage).not.toMatch(/your changes/i);
  });

  it("still reports the failure rather than swallowing it", () => {
    const error = new DatabaseError("connection pool exhausted");

    /* The wording changed; the error did not become quieter. */
    expect(error.userMessage.length).toBeGreaterThan(0);
    expect(error.code).toBe("DATABASE_ERROR");
    expect(error.severity).toBe("critical");
  });

  it("stays distinguishable from the generic fallback", () => {
    /*
     * Both are critical and both are vague, but an operator reporting what
     * they saw should still point maintainers at the database rather than at
     * the last-resort error.
     */
    expect(new DatabaseError("x").userMessage).not.toBe(new UnexpectedError("x").userMessage);
  });

  it("keeps a caller's own message when a save really is in progress", () => {
    const error = new DatabaseError("update failed", {
      userMessage: "Could not save the account. Please try again.",
    });

    expect(error.userMessage).toBe("Could not save the account. Please try again.");
  });

  it("never leaks the technical cause to the operator", () => {
    const error = new DatabaseError("duplicate key value violates unique constraint profiles_pkey");

    expect(error.userMessage).not.toContain("profiles_pkey");
  });
});

describe("stock widget separates a permission denial from an outage", () => {
  const summary: StockSummary = {
    top: [],
    almostFull: [],
    totalAllocatable: 0,
    lowStock: false,
    excludedForProblems: 0,
  };

  it("shows the stock when the read succeeds", () => {
    const presentation = presentStock(ok(summary));

    expect(presentation.kind).toBe("ready");
    expect(presentation).toEqual({ kind: "ready", stock: summary });
  });

  it("shows a permission message only for FORBIDDEN", () => {
    const presentation = presentStock(fail(new ForbiddenError("worker may not view stock")));

    expect(presentation.kind).toBe("forbidden");
  });

  it("does not call a database failure a permission problem", () => {
    /*
     * The exact defect: every failure was collapsed into null, and the widget
     * renders null as "Not available to your role". A Super Admin was told
     * their role lacked access while the real cause was an exhausted pool.
     */
    const presentation = presentStock(fail(new DatabaseError("connection pool exhausted")));

    expect(presentation.kind).toBe("error");
    expect(presentation.kind).not.toBe("forbidden");
  });

  it("reports the failure's own message, not a generic one", () => {
    const error = new DatabaseError("pool exhausted", {
      userMessage: "The database is not responding.",
    });
    const presentation = presentStock(fail(error));

    expect(presentation).toEqual({ kind: "error", message: "The database is not responding." });
  });

  it("treats any non-permission failure as an error", () => {
    /* An unreachable service is no more a permission problem than an exhausted pool is. */
    const presentation = presentStock(fail(new ExternalServiceError("database unreachable")));

    expect(presentation.kind).toBe("error");
  });
});
