/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M09D: the credentials block in the Quick Prepare and Quick Replace reviews.
 *
 * The server is stood in for by the `reveal` prop and the clipboard by a
 * recorder, so these tests watch exactly what reaches the clipboard, what is
 * fetched and when, and where a password could leak on the client.
 */

const copied: string[] = [];
let clipboardWorks = true;
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clipboard")>()),
  copyToClipboard: async (text: string) => {
    if (!clipboardWorks) return false;
    copied.push(text);
    return true;
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

const { SelectedAccountCredentials } =
  await import("@/modules/quick-prepare/components/selected-account-credentials");
const { CREDENTIAL_PAIR_SEPARATOR, formatCredentialPair } = await import("@/lib/clipboard");

const ACCOUNT = { accountId: "11111111-1111-4111-8111-111111111111", email: "pibko@example.com" };
const PASSWORD = "Quick-Secret-123!";
const OTHER = { accountId: "22222222-2222-4222-8222-222222222222", email: "other@example.com" };
const OTHER_PASSWORD = "Other-Secret-456!";

function ok(accountId: string, email: string, password: string) {
  return Promise.resolve({ ok: true as const, data: { accountId, email, password } });
}

let consoleOutput: string[] = [];

beforeEach(() => {
  copied.length = 0;
  clipboardWorks = true;
  toastSuccess.mockReset();
  toastError.mockReset();
  consoleOutput = [];
  for (const channel of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function click(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("the Copy both format", () => {
  it("is the email, four spaces, and the password, on one line", () => {
    expect(CREDENTIAL_PAIR_SEPARATOR).toBe("    ");
    expect(formatCredentialPair("pibko@example.com", "password123")).toBe(
      "pibko@example.com    password123",
    );
  });
});

describe("SelectedAccountCredentials", () => {
  it("shows the email and a masked password, and fetches nothing on load", () => {
    const reveal = vi.fn(() => ok(ACCOUNT.accountId, ACCOUNT.email, PASSWORD));
    render(<SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />);

    expect(screen.getByText(ACCOUNT.email)).toBeTruthy();
    expect(screen.queryByText(PASSWORD)).toBeNull();
    expect(screen.getByLabelText("Password hidden")).toBeTruthy();
    expect(reveal).not.toHaveBeenCalled();
    expect(copied).toEqual([]);
  });

  it("copies the email without asking the server for anything", async () => {
    const reveal = vi.fn(() => ok(ACCOUNT.accountId, ACCOUNT.email, PASSWORD));
    render(<SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />);

    click(/copy email/i);

    await waitFor(() => expect(copied).toEqual([ACCOUNT.email]));
    expect(reveal).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("Email copied");
  });

  it("copies the password, and both on one line, from a single server request", async () => {
    const reveal = vi.fn(() => ok(ACCOUNT.accountId, ACCOUNT.email, PASSWORD));
    render(<SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />);

    click(/copy password/i);
    await waitFor(() => expect(copied).toEqual([PASSWORD]));

    click(/copy both/i);
    await waitFor(() => expect(copied).toEqual([PASSWORD, `${ACCOUNT.email}    ${PASSWORD}`]));

    /* Fetched once for this selection, not once per button. */
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("sends one request however fast the buttons are pressed", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof ok>>) => void;
    const reveal = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof ok>>>((settle) => {
          resolve = settle;
        }),
    );
    render(<SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />);

    click(/copy password/i);
    /* While loading, the buttons that need the server are disabled. */
    expect((screen.getByRole("button", { name: /copy both/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: /copy both/i }));

    await act(async () => {
      resolve({ ok: true, data: { ...ACCOUNT, password: PASSWORD } });
    });

    await waitFor(() => expect(copied).toEqual([PASSWORD]));
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("says so when the clipboard refuses, and claims no success", async () => {
    clipboardWorks = false;
    const reveal = vi.fn(() => ok(ACCOUNT.accountId, ACCOUNT.email, PASSWORD));
    render(<SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />);

    click(/copy both/i);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]?.[0]).toBe("Could not copy");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("never submits the form it sits in", async () => {
    const submit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const reveal = vi.fn(() => ok(ACCOUNT.accountId, ACCOUNT.email, PASSWORD));

    render(
      <form onSubmit={submit}>
        <SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />
      </form>,
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("type")).toBe("button");
      fireEvent.click(button);
    }

    await waitFor(() => expect(copied.length).toBeGreaterThan(0));
    expect(submit).not.toHaveBeenCalled();
  });

  it("shows the password on request and hides it again", async () => {
    const reveal = vi.fn(() => ok(ACCOUNT.accountId, ACCOUNT.email, PASSWORD));
    render(<SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />);

    click(/show password/i);
    await waitFor(() => expect(screen.getByText(PASSWORD)).toBeTruthy());

    click(/hide password/i);
    expect(screen.queryByText(PASSWORD)).toBeNull();
  });

  it("discards an answer that belongs to a different account", async () => {
    const reveal = vi.fn(() => ok(OTHER.accountId, OTHER.email, OTHER_PASSWORD));
    render(<SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />);

    click(/copy both/i);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(copied).toEqual([]);
    expect(screen.queryByText(OTHER_PASSWORD)).toBeNull();
  });

  it("shows a refusal from the server without copying anything", async () => {
    const reveal = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        message: "This account is no longer the one selected for this order.",
        code: "VALIDATION_ERROR",
      }),
    );
    render(<SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />);

    click(/copy password/i);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/no longer/));
    expect(copied).toEqual([]);
  });

  it("never lets a late answer for the old account reach the new one", async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof ok>>) => void;
    const revealOld = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof ok>>>((settle) => {
          resolveOld = settle;
        }),
    );
    const revealNew = vi.fn(() => ok(OTHER.accountId, OTHER.email, OTHER_PASSWORD));

    /* Keyed by the selection, exactly as the review screens render it. */
    const { rerender } = render(
      <SelectedAccountCredentials key={ACCOUNT.accountId} {...ACCOUNT} reveal={revealOld} />,
    );

    click(/copy password/i);
    expect(revealOld).toHaveBeenCalledTimes(1);

    /* The operator picks another account before the first answer arrives. */
    rerender(<SelectedAccountCredentials key={OTHER.accountId} {...OTHER} reveal={revealNew} />);

    await act(async () => {
      resolveOld({ ok: true, data: { ...ACCOUNT, password: PASSWORD } });
    });

    /* The old password was neither copied nor shown, and the new block starts clean. */
    expect(copied).toEqual([]);
    expect(screen.queryByText(PASSWORD)).toBeNull();
    expect(screen.getByText(OTHER.email)).toBeTruthy();
    expect(screen.getByLabelText("Password hidden")).toBeTruthy();

    /* Copying now uses the new selection only. */
    click(/copy both/i);
    await waitFor(() => expect(copied).toEqual([`${OTHER.email}    ${OTHER_PASSWORD}`]));
    expect(revealNew).toHaveBeenCalledTimes(1);
  });

  it("leaves no password in storage, the URL, the console or a toast", async () => {
    const reveal = vi.fn(() => ok(ACCOUNT.accountId, ACCOUNT.email, PASSWORD));
    render(<SelectedAccountCredentials {...ACCOUNT} reveal={reveal} />);

    click(/copy both/i);
    await waitFor(() => expect(copied.length).toBe(1));

    const storage = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    expect(storage).not.toContain(PASSWORD);
    expect(window.location.href).not.toContain(PASSWORD);
    expect(consoleOutput.join("\n")).not.toContain(PASSWORD);
    expect(JSON.stringify([...toastSuccess.mock.calls, ...toastError.mock.calls])).not.toContain(
      PASSWORD,
    );
  });
});
