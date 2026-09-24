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

/* The copy and note actions import server actions; stubbed here, tested in their own file. */
vi.mock("@/modules/accounts/components/bulk-account-actions", () => ({
  CopyEmailsButton: () => <button type="button">Copy emails</button>,
  CopyCredentialsButton: () => <button type="button">Copy credentials</button>,
  BulkNoteButton: () => <button type="button">Add note</button>,
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

/** The bar for these ids, as a Super Admin sees it unless told otherwise. */
function Bar({
  ids,
  onClear = vi.fn(),
  canDelete = true,
  withProblem = [],
}: {
  ids: string[];
  onClear?: () => void;
  canDelete?: boolean;
  withProblem?: string[];
}) {
  return (
    <BulkSelectionBar
      accounts={ids.map((id) => ({ id, email: `${id}@icloud.com`, notes: null }))}
      withProblem={withProblem}
      withoutProblem={[]}
      canDelete={canDelete}
      canEditNotes
      onClear={onClear}
    />
  );
}

/** The confirm button inside the dialog, and the acknowledgement it requires. */
function confirmButton(): HTMLButtonElement {
  const dialog = screen.getByRole("alertdialog");
  const match = [...dialog.querySelectorAll("button")].find((b) =>
    /Delete \d+ account/.test(b.textContent ?? ""),
  );
  if (!match) throw new Error("No confirm button");
  return match as HTMLButtonElement;
}

function acknowledge() {
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
}

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
    const { container } = render(<Bar ids={[]} />);

    expect(container.textContent).toBe("");
  });

  it("counts the selected accounts", () => {
    render(<Bar ids={["a", "b", "c"]} />);

    expect(screen.getByText("3 accounts selected")).toBeTruthy();
  });

  it("counts a single account in the singular", () => {
    render(<Bar ids={["a"]} />);

    expect(screen.getByText("1 account selected")).toBeTruthy();
  });
});

describe("selection alone never deletes", () => {
  it("deletes nothing when the bar is merely shown", () => {
    render(<Bar ids={["a", "b"]} />);

    expect(mutate).not.toHaveBeenCalled();
  });

  it("deletes nothing when Delete opens the confirmation", () => {
    /* Opening the dialog is not consent. Nothing may leave until it is given. */
    render(<Bar ids={["a", "b"]} />);

    fireEvent.click(button("Delete"));

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("states how many accounts will be deleted", () => {
    render(<Bar ids={["a", "b", "c"]} />);

    fireEvent.click(button("Delete"));

    expect(screen.getByRole("alertdialog").textContent).toContain("Delete 3 accounts?");
  });
});

describe("clearing the selection", () => {
  it("calls onClear and deletes nothing", () => {
    const onClear = vi.fn();
    render(<Bar ids={["a", "b"]} onClear={onClear} />);

    fireEvent.click(button("Clear selection"));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("cancelling", () => {
  it("closes the dialog and deletes nothing", () => {
    const onClear = vi.fn();
    render(<Bar ids={["a", "b"]} onClear={onClear} />);

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
    render(<Bar ids={["a", "c"]} />);

    fireEvent.click(button("Delete"));
    acknowledge();
    fireEvent.click(confirmButton());

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual(["a", "c"]);
  });
});

describe("double-submit protection", () => {
  it("sends one request even when the confirm button is clicked twice", () => {
    render(<Bar ids={["a"]} />);

    fireEvent.click(button("Delete"));
    acknowledge();

    const confirm = confirmButton();

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
    const view = render(<Bar ids={["a"]} />);

    fireEvent.click(button("Delete"));
    pending = true;
    view.rerender(<Bar ids={["a"]} />);

    return view;
  }

  it("disables and marks the confirm button busy while deleting", () => {
    openThenStartDeleting();

    const confirm = confirmButton();

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
    const view = render(<Bar ids={["a"]} />);

    pending = true;
    view.rerender(<Bar ids={["a"]} />);

    const trigger = button("Delete");

    expect(trigger.hasAttribute("disabled")).toBe(true);
    expect(trigger.getAttribute("aria-busy")).toBe("true");
  });
});

describe("M03: a strong confirmation, offered only to those who may delete", () => {
  it("27. will not delete until the operator acknowledges it", () => {
    render(<Bar ids={["a", "b"]} />);

    fireEvent.click(button("Delete"));
    const confirm = confirmButton();

    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirm);
    expect(mutate).not.toHaveBeenCalled();

    acknowledge();
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("says what Delete means here, and that it affects every selected account", () => {
    render(<Bar ids={["a", "b", "c"]} />);

    fireEvent.click(button("Delete"));
    const text = screen.getByRole("alertdialog").textContent ?? "";

    expect(text).toContain("This affects all 3 selected accounts.");
    expect(text).toContain("cannot be restored from the app");
    expect(text).toContain("Archive instead");
  });

  it("offers no Delete to a role without DELETE_ACCOUNTS", () => {
    render(<Bar ids={["a"]} canDelete={false} />);

    expect(screen.queryAllByRole("button").some((b) => b.textContent === "Delete")).toBe(false);
  });

  it("offers every toolbar action, with Resolve disabled when nothing selected is blocked", () => {
    render(<Bar ids={["a", "b"]} />);

    for (const label of [
      "Copy emails",
      "Copy credentials",
      "Add note",
      "Delete",
      "Clear selection",
    ]) {
      expect(button(label)).toBeTruthy();
    }
    expect(button("Resolve").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/managed from/).textContent).toContain("Problems");
  });

  it("enables Resolve for selected accounts that do carry a blocking problem", () => {
    render(<Bar ids={["a", "b"]} withProblem={["b"]} />);

    expect(button("Resolve").hasAttribute("disabled")).toBe(false);
  });

  it("tells the operator the selection is this page only", () => {
    render(<Bar ids={["a"]} />);

    expect(screen.getByText(/On this page only/)).toBeTruthy();
  });
});
