import { describe, expect, it } from "vitest";

import {
  ACTIVE_STATUSES,
  BLOCKING_STATUSES,
  PROBLEM_STATUSES,
  allowedTransitions,
  canTransition,
  explainRefusal,
  isBlocking,
  isReopen,
  requiresResolutionNote,
  type ProblemStatus,
} from "@/modules/problems/services/problem-lifecycle";
import { problemAge } from "@/modules/problems/components/problem-shared";

/**
 * Lifecycle tests.
 *
 * No document defined these transitions, so ADR-010 Decision 1 is the only
 * authority for them and this file is what stops the graph drifting away from
 * it. Every legal move and every illegal one is asserted explicitly rather than
 * derived from the same table the implementation uses — a test that reads the
 * production constant would pass no matter what that constant said.
 */

const WORKER = false;
const ADMIN = true;

describe("allowedTransitions", () => {
  it("lets an open problem be picked up, parked, resolved or cancelled", () => {
    expect([...allowedTransitions("open", WORKER)].sort()).toEqual(
      ["cancelled", "in_progress", "resolved", "waiting"].sort(),
    );
  });

  it("lets in-progress wait, resolve or cancel — but never go back to open", () => {
    expect([...allowedTransitions("in_progress", WORKER)].sort()).toEqual(
      ["cancelled", "resolved", "waiting"].sort(),
    );
    expect(canTransition("in_progress", "open", WORKER)).toBe(false);
  });

  it("lets waiting resume, resolve or cancel", () => {
    expect([...allowedTransitions("waiting", WORKER)].sort()).toEqual(
      ["cancelled", "in_progress", "resolved"].sort(),
    );
  });

  it("lets resolved be closed or reopened", () => {
    expect([...allowedTransitions("resolved", WORKER)].sort()).toEqual(["closed", "open"].sort());
  });

  it("lets closed be reopened, and nothing else", () => {
    expect(allowedTransitions("closed", WORKER)).toEqual(["open"]);
  });

  it("makes cancelled terminal for a Worker", () => {
    expect(allowedTransitions("cancelled", WORKER)).toEqual([]);
  });

  it("lets only a Super Admin close a cancelled problem", () => {
    /* The M08 brief: Workers may NOT close cancelled problems — which implies somebody can. */
    expect(allowedTransitions("cancelled", ADMIN)).toEqual(["closed"]);
    expect(canTransition("cancelled", "closed", ADMIN)).toBe(true);
    expect(canTransition("cancelled", "closed", WORKER)).toBe(false);
  });

  it("never allows a transition to itself", () => {
    for (const status of PROBLEM_STATUSES) {
      expect(canTransition(status, status, ADMIN), `${status} -> ${status}`).toBe(false);
    }
  });

  it("never allows reviving a cancelled problem into active work", () => {
    for (const target of ["open", "in_progress", "waiting", "resolved"] as ProblemStatus[]) {
      expect(canTransition("cancelled", target, ADMIN), `cancelled -> ${target}`).toBe(false);
    }
  });

  it("never allows skipping straight from open to closed", () => {
    /* Closing without resolving would lose the resolution note the brief requires. */
    expect(canTransition("open", "closed", ADMIN)).toBe(false);
    expect(canTransition("in_progress", "closed", ADMIN)).toBe(false);
    expect(canTransition("waiting", "closed", ADMIN)).toBe(false);
  });

  it("only ever names known statuses", () => {
    for (const status of PROBLEM_STATUSES) {
      for (const target of allowedTransitions(status, ADMIN)) {
        expect(PROBLEM_STATUSES).toContain(target);
      }
    }
  });
});

describe("blocking", () => {
  it("blocks allocation only while work is outstanding", () => {
    expect(isBlocking("open")).toBe(true);
    expect(isBlocking("in_progress")).toBe(true);
    expect(isBlocking("waiting")).toBe(true);
  });

  it("stops blocking once the problem is finished", () => {
    /* Otherwise every historical problem would disable its account forever. */
    expect(isBlocking("resolved")).toBe(false);
    expect(isBlocking("closed")).toBe(false);
    expect(isBlocking("cancelled")).toBe(false);
  });

  it("keeps the SQL list in allocation.repository in step", () => {
    /*
     * quick-prepare writes these three values into a NOT EXISTS clause. ADR-003
     * forbids a repository importing another module, so the list is duplicated
     * there deliberately — this assertion is what stops the copy drifting.
     */
    expect([...BLOCKING_STATUSES].sort()).toEqual(["in_progress", "open", "waiting"]);
    expect(ACTIVE_STATUSES).toEqual(BLOCKING_STATUSES);
  });
});

describe("isReopen", () => {
  it("counts a return from resolved or closed", () => {
    expect(isReopen("resolved", "open")).toBe(true);
    expect(isReopen("closed", "open")).toBe(true);
  });

  it("does not count ordinary movement", () => {
    expect(isReopen("open", "in_progress")).toBe(false);
    expect(isReopen("waiting", "in_progress")).toBe(false);
    expect(isReopen("resolved", "closed")).toBe(false);
  });
});

describe("requiresResolutionNote", () => {
  it("demands a note only when resolving", () => {
    expect(requiresResolutionNote("resolved")).toBe(true);

    for (const status of PROBLEM_STATUSES.filter((value) => value !== "resolved")) {
      expect(requiresResolutionNote(status), status).toBe(false);
    }
  });
});

describe("explainRefusal", () => {
  it("says so plainly when the status is unchanged", () => {
    expect(explainRefusal("open", "open")).toContain("already");
  });

  it("explains that cancelled is final", () => {
    expect(explainRefusal("cancelled", "open")).toContain("cancelled");
  });

  it("never leaks an underscore into a sentence shown to a person", () => {
    expect(explainRefusal("in_progress", "closed")).not.toContain("_");
  });
});

describe("problemAge", () => {
  const now = new Date("2026-08-10T12:00:00Z");

  function minutesAgo(minutes: number): Date {
    return new Date(now.getTime() - minutes * 60_000);
  }

  it("reports coarse units", () => {
    expect(problemAge(minutesAgo(0), null, now)).toBe("just now");
    expect(problemAge(minutesAgo(5), null, now)).toBe("5m");
    expect(problemAge(minutesAgo(90), null, now)).toBe("1h");
    expect(problemAge(minutesAgo(60 * 24 * 3), null, now)).toBe("3d");
    expect(problemAge(minutesAgo(60 * 24 * 90), null, now)).toBe("3mo");
  });

  it("measures a resolved problem to its resolution, not to today", () => {
    /*
     * Otherwise a problem fixed in an hour a year ago would read "365d" and
     * every old record would look like a failure.
     */
    const created = new Date("2025-01-01T00:00:00Z");
    const resolved = new Date("2025-01-01T02:00:00Z");

    expect(problemAge(created, resolved, now)).toBe("2h");
  });

  it("never reports a negative age from clock skew", () => {
    const future = new Date(now.getTime() + 60_000);
    expect(problemAge(future, null, now)).toBe("just now");
  });
});
