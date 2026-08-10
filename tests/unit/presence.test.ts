import { describe, expect, it } from "vitest";

import { derivePresence } from "@/modules/users/services/presence";

/**
 * Presence tests.
 *
 * Presence is derived from Supabase session activity, never stored. These fix
 * the thresholds so a later change that starts writing a `last_seen` column
 * fails here rather than passing quietly.
 */

const NOW = new Date("2026-08-09T12:00:00Z");

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

describe("derivePresence", () => {
  const cases: [number, string][] = [
    [0, "online"],
    [1, "online"],
    [4, "online"],
    [5, "online"],
    [6, "idle"],
    [15, "idle"],
    [29, "idle"],
    [30, "idle"],
    [31, "offline"],
    [120, "offline"],
    [60 * 24, "offline"],
  ];

  for (const [minutes, expected] of cases) {
    it(`${minutes} minutes ago is "${expected}"`, () => {
      expect(derivePresence(minutesAgo(minutes), NOW)).toBe(expected);
    });
  }

  it("is offline with no recorded activity", () => {
    expect(derivePresence(null, NOW)).toBe("offline");
  });

  it("treats the online boundary as inclusive", () => {
    expect(derivePresence(minutesAgo(5), NOW)).toBe("online");
    expect(derivePresence(minutesAgo(6), NOW)).toBe("idle");
  });

  it("treats the idle boundary as inclusive", () => {
    expect(derivePresence(minutesAgo(30), NOW)).toBe("idle");
    expect(derivePresence(minutesAgo(31), NOW)).toBe("offline");
  });

  it("treats a future timestamp as online rather than offline", () => {
    /*
     * Clock skew between the database and the app can put activity slightly in
     * the future. Reading that as offline would be worse than reading it as
     * online - the session demonstrably exists.
     */
    const future = new Date(NOW.getTime() + 30_000);
    expect(derivePresence(future, NOW)).toBe("online");
  });
});
