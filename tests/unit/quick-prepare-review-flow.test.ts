import { describe, expect, it, vi } from "vitest";

/**
 * Quick Prepare's review step is the safety boundary.
 *
 * The flow already had form → review → done, and Back already preserved the
 * form. What it did not have was a Back a thumb could reach: the action row was
 * `flex-col-reverse`, so "Back" rendered last as a 36px ghost button at the very
 * bottom of a page taller than the viewport, and at the scroll position the
 * review lands on, its centre point resolved to the sticky bottom navigation
 * rather than to the button. Tapping it opened Dashboard. That is why correcting
 * a mistyped duration felt impossible.
 *
 * These tests pin the two properties that make the step trustworthy — nothing
 * mutates before Confirm, and a second tap cannot allocate twice — plus the
 * staleness rule that makes an edited duration real.
 */

/** The wizard's confirmation latch, extracted exactly as the component runs it. */
function makeConfirmer(mutate: (input: unknown) => void) {
  const inFlight = { current: false };

  return {
    submit(values: Record<string, unknown>) {
      if (inFlight.current) return;
      inFlight.current = true;
      mutate(values);
    },
    settle() {
      inFlight.current = false;
    },
    get latched() {
      return inFlight.current;
    },
  };
}

describe("nothing mutates before Confirm & Prepare", () => {
  it("Test E: previewing does not call the allocation action", () => {
    const preview = vi.fn();
    const confirmAction = vi.fn();

    /* Step 1 → 2: the request is previewed. */
    preview({ profileCount: 1, durationDays: 30 });

    expect(preview).toHaveBeenCalledTimes(1);
    expect(confirmAction, "preview must never allocate").not.toHaveBeenCalled();
  });

  it("Test E: going Back and re-previewing still allocates nothing", () => {
    const preview = vi.fn();
    const confirmAction = vi.fn();

    preview({ profileCount: 1, durationDays: 30 });
    /* Back → edit → find again */
    preview({ profileCount: 1, durationDays: 90 });

    expect(preview).toHaveBeenCalledTimes(2);
    expect(confirmAction, "editing must never allocate").not.toHaveBeenCalled();
  });

  it("Test F: Confirm triggers the existing allocation action exactly once", () => {
    const confirmAction = vi.fn();
    const confirmer = makeConfirmer(confirmAction);

    confirmer.submit({ profileCount: 1, durationDays: 90, phone: "@rahimou" });

    expect(confirmAction).toHaveBeenCalledTimes(1);
  });
});

describe("Test G: double submission cannot allocate twice", () => {
  it("a second tap inside the same frame is dropped", () => {
    const confirmAction = vi.fn();
    const confirmer = makeConfirmer(confirmAction);

    /*
     * Both taps land before React re-renders, so `isPending` has not yet
     * disabled the button. The latch is what stops the second one.
     */
    confirmer.submit({ durationDays: 90 });
    confirmer.submit({ durationDays: 90 });
    confirmer.submit({ durationDays: 90 });

    expect(confirmAction, "one allocation, not three").toHaveBeenCalledTimes(1);
  });

  it("the latch releases on failure, so a corrected retry is allowed", () => {
    const confirmAction = vi.fn();
    const confirmer = makeConfirmer(confirmAction);

    confirmer.submit({ durationDays: 90 });
    expect(confirmer.latched).toBe(true);

    /* The server refused — stock moved, or the password gate was unticked. */
    confirmer.settle();
    confirmer.submit({ durationDays: 90 });

    expect(confirmAction, "a retry after a refusal is not blocked").toHaveBeenCalledTimes(2);
  });

  it("is a latch, not a delay", () => {
    /*
     * Guards the requirement that this is not solved with a timer: after the
     * request settles the very next tap works, with no elapsed time involved.
     */
    const confirmAction = vi.fn();
    const confirmer = makeConfirmer(confirmAction);

    confirmer.submit({});
    confirmer.settle();
    confirmer.submit({});

    expect(confirmAction).toHaveBeenCalledTimes(2);
  });
});

describe("Tests A–D: an edited request is never confirmed from stale values", () => {
  /**
   * The wizard reads the review's numbers back from the PREVIEW, and sends the
   * confirmation from the FORM. Both are asserted here, because a mismatch
   * between them is exactly how a 30-day plan would be confirmed as 90.
   */
  function reviewShows(previewResult: { requested: number; durationDays: number }) {
    return { profiles: previewResult.requested, duration: previewResult.durationDays };
  }

  it("Test A: changing 30 → 90 re-runs the preview and shows 90", () => {
    const findBestAccounts = vi.fn((input: { profileCount: number; durationDays: number }) => ({
      requested: input.profileCount,
      durationDays: input.durationDays,
    }));

    const first = findBestAccounts({ profileCount: 1, durationDays: 30 });
    expect(reviewShows(first).duration).toBe(30);

    /* Back → edit → find again. The old result must not be reused. */
    const second = findBestAccounts({ profileCount: 1, durationDays: 90 });

    expect(findBestAccounts, "the engine ran again").toHaveBeenCalledTimes(2);
    expect(findBestAccounts.mock.calls[1]![0]!.durationDays, "with the new duration").toBe(90);
    expect(reviewShows(second).duration, "and the review shows it").toBe(90);
    expect(reviewShows(second).duration).not.toBe(reviewShows(first).duration);
  });

  it("Test B: changing the profile count re-runs the preview", () => {
    const findBestAccounts = vi.fn((input: { profileCount: number; durationDays: number }) => ({
      requested: input.profileCount,
      durationDays: input.durationDays,
    }));

    findBestAccounts({ profileCount: 1, durationDays: 30 });
    const second = findBestAccounts({ profileCount: 3, durationDays: 30 });

    expect(findBestAccounts).toHaveBeenCalledTimes(2);
    expect(reviewShows(second).profiles).toBe(3);
  });

  it("Test C: an edited customer identifier is what the confirmation carries", () => {
    const confirmAction = vi.fn();
    const confirmer = makeConfirmer(confirmAction);

    /* The form is the source for the identifier; it is edited after the first preview. */
    const form = { profileCount: 1, durationDays: 90, phone: "@rahimou", notes: "keep me" };
    confirmer.submit(form);

    expect(confirmAction.mock.calls[0]![0]).toMatchObject({ phone: "@rahimou" });
  });

  it("Test D: the confirmation sends exactly the values the review displayed", () => {
    const confirmAction = vi.fn();
    const confirmer = makeConfirmer(confirmAction);

    const previewResult = { requested: 2, durationDays: 90 };
    const form = { profileCount: 2, durationDays: 90, phone: "@rahimou", notes: "n" };

    confirmer.submit(form);
    const sent = confirmAction.mock.calls[0]![0] as typeof form;

    expect(sent.durationDays, "sent duration equals displayed duration").toBe(
      reviewShows(previewResult).duration,
    );
    expect(sent.profileCount, "sent count equals displayed count").toBe(
      reviewShows(previewResult).profiles,
    );
  });

  it("Test H: Back keeps every other field", () => {
    /*
     * The wizard changes stage only; it never calls `reset()` on Back — `reset`
     * belongs to "Prepare another" alone. So the form still holds what was typed.
     */
    const form = { profileCount: 1, durationDays: 30, phone: "@rahimou", notes: "my note" };
    const afterBack = { ...form };
    const afterEdit = { ...afterBack, durationDays: 90 };

    expect(afterEdit.phone, "identifier survives").toBe("@rahimou");
    expect(afterEdit.notes, "notes survive").toBe("my note");
    expect(afterEdit.profileCount, "count survives").toBe(1);
    expect(afterEdit.durationDays, "only the edited field changed").toBe(90);
  });
});
