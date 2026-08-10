import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEEP_LAST,
  planRetention,
  type RetentionCandidate,
} from "@/modules/backups/services/retention";

/**
 * Retention tests.
 *
 * This is the one part of the backup module whose bugs destroy backups rather
 * than merely failing to create them, so the protective rules are pinned here
 * explicitly: a future change that starts pruning restore points or snapshots
 * fails in this file.
 */

const BASE = new Date("2026-08-10T00:00:00Z");

function candidate(
  id: string,
  daysAgo: number,
  overrides: Partial<RetentionCandidate> = {},
): RetentionCandidate {
  return {
    id,
    createdAt: new Date(BASE.getTime() - daysAgo * 24 * 60 * 60 * 1000),
    type: "daily",
    isRestorePoint: false,
    ...overrides,
  };
}

describe("planRetention", () => {
  it("keeps everything when under the limit", () => {
    const plan = planRetention([candidate("a", 1), candidate("b", 2)], 30);

    expect(plan.prune).toEqual([]);
    expect(plan.keep).toHaveLength(2);
  });

  it("prunes the oldest beyond the limit", () => {
    const candidates = [candidate("newest", 1), candidate("middle", 2), candidate("oldest", 3)];

    const plan = planRetention(candidates, 2);

    expect(plan.prune).toEqual(["oldest"]);
    expect(plan.keep).toEqual(["newest", "middle"]);
  });

  it("never prunes a restore point, however old", () => {
    const candidates = [
      candidate("recent", 1),
      candidate("ancient-marker", 900, { isRestorePoint: true }),
    ];

    const plan = planRetention(candidates, 1);

    expect(plan.prune).not.toContain("ancient-marker");
    expect(plan.keep).toContain("ancient-marker");
  });

  it("never prunes a snapshot, however old", () => {
    const candidates = [
      candidate("recent", 1),
      candidate("old-snapshot", 900, { type: "snapshot" }),
    ];

    const plan = planRetention(candidates, 1);

    expect(plan.prune).not.toContain("old-snapshot");
  });

  it("does not let protected backups consume retention slots", () => {
    /*
     * The failure this prevents: a burst of snapshots filling the quota and
     * evicting every routine backup, leaving nothing recent to restore from.
     */
    const candidates = [
      candidate("snap-1", 1, { type: "snapshot" }),
      candidate("snap-2", 2, { type: "snapshot" }),
      candidate("snap-3", 3, { type: "snapshot" }),
      candidate("daily-1", 4),
      candidate("daily-2", 5),
    ];

    const plan = planRetention(candidates, 2);

    expect(plan.prune).toEqual([]);
    expect(plan.keep).toHaveLength(5);
  });

  it("clamps a nonsensical limit so the newest backup always survives", () => {
    const candidates = [candidate("newest", 1), candidate("older", 2)];

    /*
     * Zero or negative would otherwise mean "keep nothing" — a policy that
     * deletes every backup. Clamping to MIN_KEEP_LAST guarantees a survivor;
     * it does not mean nothing is pruned.
     */
    for (const limit of [0, -5, Number.NaN]) {
      const plan = planRetention(candidates, limit);

      expect(plan.keep).toContain("newest");
      expect(plan.prune).not.toContain("newest");
    }
  });

  it("never prunes above the maximum limit", () => {
    const candidates = [candidate("a", 1)];

    expect(planRetention(candidates, 10_000).prune).toEqual([]);
  });

  it("handles an empty catalogue", () => {
    const plan = planRetention([], DEFAULT_KEEP_LAST);

    expect(plan.keep).toEqual([]);
    expect(plan.prune).toEqual([]);
  });

  it("orders by recency, not by input order", () => {
    const candidates = [candidate("oldest", 10), candidate("newest", 1), candidate("middle", 5)];

    const plan = planRetention(candidates, 1);

    expect(plan.keep).toEqual(["newest"]);
    expect(plan.prune).toEqual(["middle", "oldest"]);
  });
});
