/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Declaring and resolving problems for a selection of accounts.
 *
 * The mutation hooks are mocked, not the components: what is under test is the
 * real markup and the real event wiring, while nothing reaches a server action.
 * `isPending` is driven by hand, because the point is to observe the dialog
 * mid-request.
 *
 * The rule these dialogs must not break is that a mandatory field stays
 * mandatory in bulk. A resolution note is required for a single problem by a
 * Zod schema and by a check constraint on the table; acting on ten accounts is
 * not a reason to accept a blank one.
 */

/*
 * jsdom implements neither of these, and Radix's Select measures its trigger on
 * mount. Without them the Declare dialog throws before it can be asserted on.
 * Stubs rather than shims: nothing here depends on a real measurement.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

const declareMutate = vi.fn();
const resolveMutate = vi.fn();

let declarePending = false;
let resolvePending = false;

vi.mock("@/modules/accounts/hooks/use-bulk-problem-mutations", () => ({
  useDeclareProblems: () => ({
    mutate: declareMutate,
    get isPending() {
      return declarePending;
    },
  }),
  useResolveProblems: () => ({
    mutate: resolveMutate,
    get isPending() {
      return resolvePending;
    },
  }),
}));

const { BulkDeclareProblemDialog, BulkResolveProblemsDialog } =
  await import("@/modules/accounts/components/bulk-problem-dialogs");

beforeEach(() => {
  declareMutate.mockReset();
  resolveMutate.mockReset();
  declarePending = false;
  resolvePending = false;
});

afterEach(cleanup);

function button(name: string): HTMLButtonElement {
  const match = screen.getAllByRole("button").find((el) => el.textContent?.includes(name));

  if (!match) {
    throw new Error(`No button labelled ${name}`);
  }

  return match as HTMLButtonElement;
}

describe("each action is offered only where it applies", () => {
  it("offers Resolve for no accounts when none has a problem", () => {
    const { container } = render(<BulkResolveProblemsDialog accountIds={[]} onDone={vi.fn()} />);

    expect(container.textContent).toBe("");
  });

  it("offers Declare for no accounts when every one already has a problem", () => {
    const { container } = render(<BulkDeclareProblemDialog accountIds={[]} onDone={vi.fn()} />);

    expect(container.textContent).toBe("");
  });

  it("offers Resolve when at least one selected account has a problem", () => {
    render(<BulkResolveProblemsDialog accountIds={["a"]} onDone={vi.fn()} />);

    expect(button("Resolve")).toBeTruthy();
  });

  it("offers Declare when at least one selected account is healthy", () => {
    render(<BulkDeclareProblemDialog accountIds={["a"]} onDone={vi.fn()} />);

    expect(button("Declare problem")).toBeTruthy();
  });
});

describe("opening a dialog changes nothing", () => {
  it("does not resolve anything when the dialog opens", () => {
    render(<BulkResolveProblemsDialog accountIds={["a", "b"]} onDone={vi.fn()} />);

    fireEvent.click(button("Resolve"));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(resolveMutate).not.toHaveBeenCalled();
  });

  it("states how many accounts will be resolved", () => {
    render(<BulkResolveProblemsDialog accountIds={["a", "b"]} onDone={vi.fn()} />);

    fireEvent.click(button("Resolve"));

    expect(screen.getByRole("dialog").textContent).toContain("Resolve 2 accounts?");
  });

  it("states how many accounts will get a problem", () => {
    render(<BulkDeclareProblemDialog accountIds={["a", "b", "c"]} onDone={vi.fn()} />);

    fireEvent.click(button("Declare problem"));

    expect(screen.getByRole("dialog").textContent).toContain("Declare a problem on 3 accounts?");
  });
});

describe("cancelling", () => {
  it("closes without resolving, and keeps the selection", () => {
    const onDone = vi.fn();
    render(<BulkResolveProblemsDialog accountIds={["a"]} onDone={onDone} />);

    fireEvent.click(button("Resolve"));
    fireEvent.click(button("Cancel"));

    expect(resolveMutate).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the mandatory note survives being in bulk", () => {
  it("refuses to resolve without a resolution note", async () => {
    render(<BulkResolveProblemsDialog accountIds={["a"]} onDone={vi.fn()} />);

    fireEvent.click(button("Resolve"));
    fireEvent.click(button("Resolve problems"));

    await waitFor(() => {
      expect(screen.getByText("Explain how it was resolved")).toBeTruthy();
    });

    expect(resolveMutate).not.toHaveBeenCalled();
  });

  it("refuses a note too short to explain anything", async () => {
    render(<BulkResolveProblemsDialog accountIds={["a"]} onDone={vi.fn()} />);

    fireEvent.click(button("Resolve"));
    fireEvent.change(screen.getByLabelText("How it was resolved"), { target: { value: "fixed" } });
    fireEvent.click(button("Resolve problems"));

    await waitFor(() => {
      expect(resolveMutate).not.toHaveBeenCalled();
    });
  });

  it("asks for the problem type only — no severity, no description (M03)", async () => {
    render(<BulkDeclareProblemDialog accountIds={["a"]} onDone={vi.fn()} />);

    fireEvent.click(button("Declare problem"));

    expect(screen.getByLabelText("Problem type")).toBeTruthy();
    expect(screen.queryByLabelText("What happened")).toBeNull();
    expect(screen.queryByLabelText("Severity")).toBeNull();
  });
});

describe("submitting", () => {
  it("resolves exactly the accounts it was given", async () => {
    render(<BulkResolveProblemsDialog accountIds={["a", "c"]} onDone={vi.fn()} />);

    fireEvent.click(button("Resolve"));
    fireEvent.change(screen.getByLabelText("How it was resolved"), {
      target: { value: "Reset the password and signed back in." },
    });
    fireEvent.click(button("Resolve problems"));

    await waitFor(() => {
      expect(resolveMutate).toHaveBeenCalledTimes(1);
    });

    expect(resolveMutate.mock.calls[0]?.[0]).toMatchObject({ ids: ["a", "c"] });
  });

  it("sends the note the operator typed", async () => {
    render(<BulkResolveProblemsDialog accountIds={["a"]} onDone={vi.fn()} />);

    fireEvent.click(button("Resolve"));
    fireEvent.change(screen.getByLabelText("How it was resolved"), {
      target: { value: "Paid the outstanding invoice." },
    });
    fireEvent.click(button("Resolve problems"));

    await waitFor(() => {
      expect(resolveMutate).toHaveBeenCalled();
    });

    expect(resolveMutate.mock.calls[0]?.[0].input).toMatchObject({
      resolutionNote: "Paid the outstanding invoice.",
    });
  });

  it("declares the chosen problem type on exactly the accounts it was given", async () => {
    render(<BulkDeclareProblemDialog accountIds={["a", "b"]} onDone={vi.fn()} />);

    fireEvent.click(button("Declare problem"));
    fireEvent.click(button("Declare problem"));

    await waitFor(() => {
      expect(declareMutate).toHaveBeenCalledTimes(1);
    });

    const sent = declareMutate.mock.calls[0]?.[0] as { ids: string[]; input: object };
    expect(sent.ids).toEqual(["a", "b"]);
    expect(sent.input).toEqual({ issueType: "something_went_wrong", assignToMe: false });
  });
});

describe("double-submit protection", () => {
  it("sends one request even when the confirm button is clicked twice", async () => {
    render(<BulkResolveProblemsDialog accountIds={["a"]} onDone={vi.fn()} />);

    fireEvent.click(button("Resolve"));
    fireEvent.change(screen.getByLabelText("How it was resolved"), {
      target: { value: "Reset the password and signed back in." },
    });

    const confirm = button("Resolve problems");
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(resolveMutate).toHaveBeenCalledTimes(1);
    });

    /* The request is now in flight; a second click must be ignored. */
    resolvePending = true;
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(resolveMutate).toHaveBeenCalledTimes(1);
    });
  });
});

describe("the loading state", () => {
  it("disables and marks the confirm button busy while resolving", () => {
    const view = render(<BulkResolveProblemsDialog accountIds={["a"]} onDone={vi.fn()} />);

    fireEvent.click(button("Resolve"));
    resolvePending = true;
    view.rerender(<BulkResolveProblemsDialog accountIds={["a"]} onDone={vi.fn()} />);

    const confirm = button("Resolve problems");

    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.getAttribute("data-loading")).toBe("true");
  });

  it("disables Cancel while resolving, so the dialog cannot be dismissed", () => {
    const view = render(<BulkResolveProblemsDialog accountIds={["a"]} onDone={vi.fn()} />);

    fireEvent.click(button("Resolve"));
    resolvePending = true;
    view.rerender(<BulkResolveProblemsDialog accountIds={["a"]} onDone={vi.fn()} />);

    expect(button("Cancel").hasAttribute("disabled")).toBe(true);
  });

  it("shows the loading affordance on the bar button while declaring", () => {
    const view = render(<BulkDeclareProblemDialog accountIds={["a"]} onDone={vi.fn()} />);

    declarePending = true;
    view.rerender(<BulkDeclareProblemDialog accountIds={["a"]} onDone={vi.fn()} />);

    const trigger = button("Declare problem");

    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
  });
});
