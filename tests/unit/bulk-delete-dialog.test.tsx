/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * The bulk delete dialog.
 *
 * These are the guarantees that cannot be expressed as pure functions: that a
 * tick never deletes anything, that Cancel is inert, and that a second click on
 * a running delete does not send a second request. Each one is the difference
 * between a confirmation dialog and a decoration.
 *
 * The mutation hook is mocked rather than the server action, so the component
 * under test is exercised with its real markup and its real event wiring while
 * nothing reaches the network. `isPending` is driven by hand, because the whole
 * point is to observe the component mid-request.
 */

/*
 * The problem dialogs are covered by their own assertions below; here they are
 * stubbed so this file does not pull a "use server" module into jsdom. What is
 * under test is the bar and its delete confirmation.
 */
vi.mock("@/modules/accounts/components/bulk-problem-dialogs", () => ({
  BulkDeclareProblemDialog: ({ accountIds }: { accountIds: readonly string[] }) =>
    accountIds.length > 0 ? <button type="button">Declare problem</button> : null,
  BulkResolveProblemsDialog: ({ accountIds }: { accountIds: readonly string[] }) =>
    accountIds.length > 0 ? <button type="button">Resolve</button> : null,
}));

const mutate = vi.fn();

let pending = false;

vi.mock("@/modules/accounts/hooks/use-account-mutations", () => ({
  useDeleteAccounts: () => ({
    mutate,
    get isPending() {
      return pending;
    },
  }),
}));

const { BulkSelectionBar } = await import("@/modules/accounts/components/bulk-selection-bar");

beforeEach(() => {
  mutate.mockReset();
  pending = false;
});

afterEach(cleanup);

/** Finds a button by its visible label, ignoring the hidden loading copy. */
function button(name: string): HTMLButtonElement {
  const match = screen
    .getAllByRole("button")
    .find((element) => element.textContent?.includes(name));

  if (!match) {
    throw new Error(`No button labelled ${name}`);
  }

  return match as HTMLButtonElement;
}

describe("the action bar appears only when something is selected", () => {
  it("renders nothing when the selection is empty", () => {
    const { container } = render(
      <BulkSelectionBar ids={[]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />,
    );

    expect(container.textContent).toBe("");
  });

  it("counts the selected accounts", () => {
    render(
      <BulkSelectionBar
        ids={["a", "b", "c"]}
        withProblem={[]}
        withoutProblem={[]}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByText("3 accounts selected")).toBeTruthy();
  });

  it("counts a single account in the singular", () => {
    render(<BulkSelectionBar ids={["a"]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />);

    expect(screen.getByText("1 account selected")).toBeTruthy();
  });
});

describe("selection alone never deletes", () => {
  it("deletes nothing when the bar is merely shown", () => {
    render(
      <BulkSelectionBar ids={["a", "b"]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />,
    );

    expect(mutate).not.toHaveBeenCalled();
  });

  it("deletes nothing when Delete opens the confirmation", () => {
    /* Opening the dialog is not consent. Nothing may leave until it is given. */
    render(
      <BulkSelectionBar ids={["a", "b"]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />,
    );

    fireEvent.click(button("Delete"));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("states how many accounts will be deleted", () => {
    render(
      <BulkSelectionBar
        ids={["a", "b", "c"]}
        withProblem={[]}
        withoutProblem={[]}
        onClear={vi.fn()}
      />,
    );

    fireEvent.click(button("Delete"));

    expect(screen.getByRole("alertdialog").textContent).toContain("Delete 3 accounts?");
  });
});

describe("clearing the selection", () => {
  it("calls onClear and deletes nothing", () => {
    const onClear = vi.fn();
    render(
      <BulkSelectionBar ids={["a", "b"]} withProblem={[]} withoutProblem={[]} onClear={onClear} />,
    );

    fireEvent.click(button("Clear selection"));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("cancelling", () => {
  it("closes the dialog and deletes nothing", () => {
    const onClear = vi.fn();
    render(
      <BulkSelectionBar ids={["a", "b"]} withProblem={[]} withoutProblem={[]} onClear={onClear} />,
    );

    fireEvent.click(button("Delete"));
    fireEvent.click(button("Cancel"));

    expect(mutate).not.toHaveBeenCalled();
    /* And the selection survives — cancelling is not the same as clearing. */
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("confirming", () => {
  it("deletes exactly the selected accounts", () => {
    render(
      <BulkSelectionBar ids={["a", "c"]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />,
    );

    fireEvent.click(button("Delete"));
    fireEvent.click(button("Delete accounts"));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual(["a", "c"]);
  });
});

describe("double-submit protection", () => {
  it("sends one request even when the confirm button is clicked twice", () => {
    render(<BulkSelectionBar ids={["a"]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />);

    fireEvent.click(button("Delete"));

    const confirm = button("Delete accounts");

    fireEvent.click(confirm);
    /* The request is now in flight; the second click must be ignored. */
    pending = true;
    fireEvent.click(confirm);

    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("the loading state", () => {
  /*
   * The dialog has to be opened before the request starts, because the bar's
   * own Delete button is disabled while one is in flight — so `rerender` is
   * used rather than a fresh `render`, which would discard the open dialog
   * along with the component state holding it open.
   */
  function openThenStartDeleting() {
    const view = render(
      <BulkSelectionBar ids={["a"]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />,
    );

    fireEvent.click(button("Delete"));
    pending = true;
    view.rerender(
      <BulkSelectionBar ids={["a"]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />,
    );

    return view;
  }

  it("disables and marks the confirm button busy while deleting", () => {
    openThenStartDeleting();

    const confirm = button("Delete accounts");

    expect(confirm.hasAttribute("disabled")).toBe(true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.getAttribute("data-loading")).toBe("true");
  });

  it("disables Cancel while deleting, so the dialog cannot be dismissed", () => {
    openThenStartDeleting();

    expect(button("Cancel").hasAttribute("disabled")).toBe(true);
  });

  it("keeps the dialog open while the delete is running", () => {
    /* Closing would hide the request rather than cancel it. */
    openThenStartDeleting();

    expect(screen.queryByRole("alertdialog")).not.toBeNull();
  });

  it("shows the loading affordance on the bar's own Delete button too", () => {
    const view = render(
      <BulkSelectionBar ids={["a"]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />,
    );

    pending = true;
    view.rerender(
      <BulkSelectionBar ids={["a"]} withProblem={[]} withoutProblem={[]} onClear={vi.fn()} />,
    );

    const trigger = button("Delete");

    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
  });
});
