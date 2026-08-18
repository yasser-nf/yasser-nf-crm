import { describe, expect, it } from "vitest";

import type { ProfileCellState } from "@/modules/accounts";
import {
  PROFILE_STATE_LABELS,
  PROFILE_STATE_STYLES,
  type ProfileSlotState,
} from "@/shared/ui/profile-state";

/**
 * One profile-state vocabulary, shared by every screen that shows slots.
 *
 * The four colours lived inside the accounts module's `ProfileIndicators` until
 * Quick Replace needed them from a Client Component, which cannot import the
 * accounts barrel — that barrel re-exports `server-only` services and pulling it
 * into the client bundle is a build error. Rather than copy the palette into a
 * second component, it moved to `@/shared/ui/profile-state`.
 *
 * Two things can now drift, and this file guards both:
 *
 *   1. the domain gaining a state the design system has no treatment for
 *   2. the two maps disagreeing with each other
 *
 * The type import is erased at runtime, so this stays a pure unit test with no
 * database and no environment.
 */

/**
 * Exhaustiveness, checked by the compiler.
 *
 * A `Record` keyed by the DOMAIN type must name every member. If
 * `ProfileCellState` gains a fifth state, this object stops typechecking with a
 * missing-property error — before anything renders a slot with no colour.
 *
 * A plain array would not do this: a subset of a union is still a valid array of
 * that union, so the drift would pass silently.
 */
const EVERY_DOMAIN_STATE: Record<ProfileCellState, true> = {
  sold: true,
  available: true,
  expired: true,
  not_for_sale: true,
};

/**
 * And the same in the other direction: the design system's own union must not
 * gain a state the domain cannot produce.
 */
const EVERY_DESIGN_STATE: Record<ProfileSlotState, true> = {
  sold: true,
  available: true,
  expired: true,
  not_for_sale: true,
};

describe("the shared profile-state vocabulary", () => {
  it("styles every state the domain can produce", () => {
    expect(Object.keys(PROFILE_STATE_STYLES).toSorted()).toEqual(
      Object.keys(EVERY_DOMAIN_STATE).toSorted(),
    );
  });

  it("labels every state the domain can produce", () => {
    expect(Object.keys(PROFILE_STATE_LABELS).toSorted()).toEqual(
      Object.keys(EVERY_DOMAIN_STATE).toSorted(),
    );
  });

  it("describes exactly the states the design system declares", () => {
    expect(Object.keys(EVERY_DESIGN_STATE).toSorted()).toEqual(
      Object.keys(EVERY_DOMAIN_STATE).toSorted(),
    );
  });

  it("gives each state a visually distinct treatment", () => {
    const styles = Object.values(PROFILE_STATE_STYLES);

    /* Four states that look alike are one state with extra steps. */
    expect(new Set(styles).size).toBe(styles.length);
  });

  it("gives each state a distinct, human label", () => {
    const labels = Object.values(PROFILE_STATE_LABELS);

    expect(new Set(labels).size).toBe(labels.length);

    for (const label of labels) {
      /* Operator-facing wording, never the raw enum value. */
      expect(label).not.toMatch(/_/);
    }
  });

  it("carries no colour value of its own", () => {
    /*
     * Every treatment must come from the palette tokens 04_UI_GUIDELINES.md
     * defines. A literal hex here would be a second palette, invisible to a
     * theme change.
     */
    for (const style of Object.values(PROFILE_STATE_STYLES)) {
      expect(style).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(style).not.toMatch(/\brgb\(|\bhsl\(/i);
    }
  });
});
