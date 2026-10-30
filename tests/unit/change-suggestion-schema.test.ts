import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MAX_EXCLUDED_ACCOUNTS,
  previewAllocationSchema,
  quickPrepareSchema,
  replaceLookupSchema,
  reviewedAccountsSchema,
} from "@/modules/quick-prepare/validation/quick-prepare.schema";

/**
 * M09C input contracts.
 *
 * These lists reach a NOT IN and an IN clause, and the reviewed list is part of
 * an idempotency hash. What they refuse, and how they normalise, matters as
 * much as what they accept.
 */

const order = { profileCount: 1, durationDays: 30 };

describe("excluding turned-down suggestions", () => {
  it("drops duplicates, so a list cannot grow by repetition", () => {
    const id = randomUUID();
    const parsed = previewAllocationSchema.parse({ ...order, excludeAccountIds: [id, id, id] });
    expect(parsed.excludeAccountIds).toEqual([id]);
  });

  it("refuses an unbounded list and anything that is not an account id", () => {
    const tooMany = Array.from({ length: MAX_EXCLUDED_ACCOUNTS + 1 }, () => randomUUID());
    expect(
      previewAllocationSchema.safeParse({ ...order, excludeAccountIds: tooMany }).success,
    ).toBe(false);
    expect(
      previewAllocationSchema.safeParse({ ...order, excludeAccountIds: ["1; drop table"] }).success,
    ).toBe(false);
  });

  it("is optional — an ordinary preview is unchanged", () => {
    expect(previewAllocationSchema.parse(order)).toEqual(order);
  });
});

describe("the reviewed accounts on a confirmation", () => {
  it("deduplicates, so the same review hashes the same", () => {
    const id = randomUUID();
    const parsed = quickPrepareSchema.parse({
      ...order,
      phone: "0663947130",
      accountIds: [id, id],
    });
    expect(parsed.accountIds).toEqual([id]);
  });

  it("never accepts an empty list as 'no restriction'", () => {
    expect(
      quickPrepareSchema.safeParse({ ...order, phone: "0663947130", accountIds: [] }).success,
    ).toBe(false);
  });

  it("is required by the Server Action, though optional for server callers", () => {
    expect(reviewedAccountsSchema.safeParse({}).success).toBe(false);
    expect(reviewedAccountsSchema.safeParse({ accountIds: [] }).success).toBe(false);
    expect(reviewedAccountsSchema.safeParse({ accountIds: [randomUUID()] }).success).toBe(true);
    expect(quickPrepareSchema.safeParse({ ...order, phone: "0663947130" }).success).toBe(true);
  });
});

describe("Quick Replace lookups", () => {
  it("accept exclusions and an earlier proposal to re-check, both optional", () => {
    const id = randomUUID();
    const parsed = replaceLookupSchema.parse({
      accountEmail: "Someone@Example.com",
      excludeAccountIds: [id, id],
      replacementAccountId: id,
    });
    expect(parsed.excludeAccountIds).toEqual([id]);
    expect(parsed.replacementAccountId).toBe(id);
    expect(replaceLookupSchema.safeParse({ accountEmail: "a@b.co" }).success).toBe(true);
    expect(
      replaceLookupSchema.safeParse({ accountEmail: "a@b.co", replacementAccountId: "x" }).success,
    ).toBe(false);
  });
});
