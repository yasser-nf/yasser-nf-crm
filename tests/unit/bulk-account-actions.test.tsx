/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The Accounts toolbar's Copy Email, Copy Credentials and Add/Edit Note (M03
 * revision), with the clipboard and the server actions stood in for.
 *
 * The credential tests watch every place a password could leak on the client:
 * localStorage, sessionStorage, the URL, the console and the toast text.
 */

const PASSWORDS = ["Alpha-Secret-111!", "Bravo-Secret-222!"];

const copied: string[] = [];
const revealAccountCredentialsAction = vi.fn();
const setAccountNotesAction = vi.fn();
const updateAccountAction = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clipboard")>()),
  copyToClipboard: async (text: string) => {
    copied.push(text);
    return true;
  },
}));

vi.mock("@/modules/accounts/actions/account.actions", () => ({
  revealAccountCredentialsAction: (ids: unknown) => revealAccountCredentialsAction(ids),
  setAccountNotesAction: (ids: unknown, input: unknown) => setAccountNotesAction(ids, input),
  updateAccountAction: (id: string, input: unknown) => updateAccountAction(id, input),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    warning: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { CopyEmailsButton, CopyCredentialsButton, BulkNoteButton, notesThatWouldBeReplaced } =
  await import("@/modules/accounts/components/bulk-account-actions");
const { CREDENTIAL_BLOCK_SEPARATOR, formatCredentialBlocks, formatEmailList } =
  await import("@/lib/clipboard");

const ONE = [{ id: "a", email: "one@icloud.com", notes: null }];
const TWO = [
  { id: "a", email: "one@icloud.com", notes: null },
  { id: "b", email: "two@icloud.com", notes: "Existing note" },
];

function withClient(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

let consoleOutput: string[] = [];

beforeEach(() => {
  copied.length = 0;
  for (const m of [
    revealAccountCredentialsAction,
    setAccountNotesAction,
    updateAccountAction,
    toastSuccess,
    toastError,
  ]) {
    m.mockReset();
  }
  revealAccountCredentialsAction.mockResolvedValue({
    ok: true,
    data: [
      { email: "one@icloud.com", password: PASSWORDS[0] },
      { email: "two@icloud.com", password: PASSWORDS[1] },
    ],
  });
  setAccountNotesAction.mockResolvedValue({ ok: true, data: { updated: 2 } });
  updateAccountAction.mockResolvedValue({ ok: true, data: {} });

  localStorage.clear();
  sessionStorage.clear();
  consoleOutput = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------------- */

describe("the formats", () => {
  it("12. emails, one per line, nothing else", () => {
    expect(formatEmailList(["a@x.com", "b@x.com", "c@x.com"])).toBe("a@x.com\nb@x.com\nc@x.com");
  });

  it("14. one existing Email/Password block per account, clearly separated", () => {
    const text = formatCredentialBlocks([
      { email: "a@x.com", password: "p1" },
      { email: "b@x.com", password: "p2" },
    ]);

    expect(text).toBe(
      `Email\na@x.com\n\nPassword\np1${CREDENTIAL_BLOCK_SEPARATOR}Email\nb@x.com\n\nPassword\np2`,
    );
  });

  it("a single account is exactly the existing single-account format", () => {
    expect(formatCredentialBlocks([{ email: "a@x.com", password: "p1" }])).toBe(
      "Email\na@x.com\n\nPassword\np1",
    );
  });
});

describe("Copy Email", () => {
  it("11. copies one email", async () => {
    render(<CopyEmailsButton accounts={ONE} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy email/ }));

    await waitFor(() => expect(copied).toEqual(["one@icloud.com"]));
    expect(toastSuccess).toHaveBeenCalledWith("Email copied");
  });

  it("12. copies several emails, one per line, and asks the server for nothing", async () => {
    render(<CopyEmailsButton accounts={TWO} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy emails/ }));

    await waitFor(() => expect(copied).toEqual(["one@icloud.com\ntwo@icloud.com"]));
    expect(revealAccountCredentialsAction).not.toHaveBeenCalled();
  });
});

describe("Copy Credentials", () => {
  it("13. asks the server for exactly the selected ids and copies the blocks", async () => {
    render(<CopyCredentialsButton accounts={TWO} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy credentials/ }));

    await waitFor(() => expect(copied).toHaveLength(1));
    expect(revealAccountCredentialsAction).toHaveBeenCalledWith(["a", "b"]);
    expect(copied[0]).toBe(
      formatCredentialBlocks([
        { email: "one@icloud.com", password: PASSWORDS[0]! },
        { email: "two@icloud.com", password: PASSWORDS[1]! },
      ]),
    );
  });

  it("16. leaves no password in storage, the URL, the console, the toast or the page", async () => {
    render(<CopyCredentialsButton accounts={TWO} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy credentials/ }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

    const surfaces = [
      JSON.stringify({ ...localStorage }),
      JSON.stringify({ ...sessionStorage }),
      window.location.href,
      consoleOutput.join("\n"),
      JSON.stringify(toastSuccess.mock.calls),
      document.body.innerHTML,
    ].join("\n");

    for (const password of PASSWORDS) {
      expect(surfaces).not.toContain(password);
    }
  });

  it("15. shows the server's refusal and copies nothing", async () => {
    revealAccountCredentialsAction.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      message: "You do not have permission to copy account credentials.",
    });

    render(<CopyCredentialsButton accounts={ONE} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy credentials/ }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not copy credentials", {
        description: "You do not have permission to copy account credentials.",
      }),
    );
    expect(copied).toEqual([]);
  });
});

describe("Add/Edit Note", () => {
  it("17–18. one account opens the existing account note editor, prefilled", () => {
    withClient(<BulkNoteButton accounts={[{ id: "b", email: "two@icloud.com", notes: "Old" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit note/ }));

    expect((screen.getByLabelText("Internal note") as HTMLTextAreaElement).value).toBe("Old");
    expect(screen.getByRole("dialog").textContent).toContain("two@icloud.com");
  });

  it("19. several accounts need explicit confirmation before anything is sent", async () => {
    withClient(<BulkNoteButton accounts={TWO} />);
    fireEvent.click(screen.getByRole("button", { name: /Add note/ }));

    fireEvent.change(screen.getByLabelText("Internal note"), { target: { value: "Shared note" } });
    const save = screen.getByRole("button", { name: /Save note on 2 accounts/ });

    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.click(save);
    expect(setAccountNotesAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Apply this note to all 2/ }));
    fireEvent.click(save);

    await waitFor(() => expect(setAccountNotesAction).toHaveBeenCalledTimes(1));
    expect(setAccountNotesAction).toHaveBeenCalledWith(["a", "b"], {
      note: "Shared note",
      confirmOverwrite: true,
      expectedNotes: { a: null, b: "Existing note" },
    });
  });

  it("20. says how many existing notes would be replaced", () => {
    withClient(<BulkNoteButton accounts={TWO} />);
    fireEvent.click(screen.getByRole("button", { name: /Add note/ }));
    fireEvent.change(screen.getByLabelText("Internal note"), { target: { value: "New" } });

    expect(screen.getByRole("alert").textContent).toContain("1 of these 2 accounts already have");
  });

  it("does not count an identical note, or an empty one, as replaced", () => {
    expect(notesThatWouldBeReplaced(TWO, "Existing note")).toBe(0);
    expect(notesThatWouldBeReplaced(TWO, "Something else")).toBe(1);
    expect(notesThatWouldBeReplaced(ONE, "Anything")).toBe(0);
  });
});
