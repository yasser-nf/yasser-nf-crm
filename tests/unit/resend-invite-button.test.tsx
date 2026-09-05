/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The Resend invite control.
 *
 * The interesting cases are the ones a confirmation dialog invites: a second
 * click while the first is still in flight, and a button that never stops
 * looking busy because the failure path forgot to clear it.
 */

const resendInviteAction = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const refresh = vi.fn();

vi.mock("@/modules/users/actions/user.actions", () => ({
  resendInviteAction: (id: string) => resendInviteAction(id),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string, o?: { description?: string }) => toastError(m, o),
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { ResendInviteButton } = await import("@/modules/users/components/resend-invite-button");

function renderButton() {
  /* retry:false — a retrying mutation would mask the single-call assertions. */
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <ResendInviteButton userId="user-2" email="invited@example.com" />
    </QueryClientProvider>,
  );
}

/** Opens the confirmation and returns its confirm button. */
function openConfirm() {
  renderButton();
  fireEvent.click(screen.getByLabelText("Resend invitation to invited@example.com"));

  return screen.getByRole("button", { name: "Resend invite" });
}

beforeEach(() => {
  resendInviteAction.mockReset().mockResolvedValue({ ok: true, data: { id: "user-2" } });
  toastSuccess.mockReset();
  toastError.mockReset();
  refresh.mockReset();
});

afterEach(cleanup);

describe("it asks before sending", () => {
  it("sends nothing on the first click", () => {
    renderButton();

    fireEvent.click(screen.getByLabelText("Resend invitation to invited@example.com"));

    expect(resendInviteAction).not.toHaveBeenCalled();
  });

  it("names the recipient in the confirmation", () => {
    renderButton();
    fireEvent.click(screen.getByLabelText("Resend invitation to invited@example.com"));

    expect(screen.getByText("Resend invitation?")).toBeTruthy();
    expect(screen.getByText(/will send a new invitation link to/)).toBeTruthy();
    expect(
      screen.getByText(/previous invitation link will no longer be the one to use/),
    ).toBeTruthy();
  });

  it("sends nothing when cancelled", () => {
    renderButton();
    fireEvent.click(screen.getByLabelText("Resend invitation to invited@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(resendInviteAction).not.toHaveBeenCalled();
  });

  it("sends on confirm, with the user's id", async () => {
    fireEvent.click(openConfirm());

    await waitFor(() => expect(resendInviteAction).toHaveBeenCalledWith("user-2"));
  });
});

describe("double submission", () => {
  it("sends once however many times the confirm is clicked", async () => {
    /*
     * The whole reason the dialog's default close is prevented: while the
     * request is in flight the confirm button is still mounted, so it has to
     * refuse the extra clicks itself.
     */
    let release: (v: unknown) => void = () => {};
    resendInviteAction.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const confirm = openConfirm();

    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(resendInviteAction).toHaveBeenCalledTimes(1));

    release({ ok: true, data: { id: "user-2" } });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

    expect(resendInviteAction).toHaveBeenCalledTimes(1);
  });

  it("shows a busy label and disables the confirm while sending", async () => {
    resendInviteAction.mockReturnValue(new Promise(() => {}));

    const confirm = openConfirm();
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.getByRole("button", { name: "Sending…" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Sending…" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("what happens afterwards", () => {
  it("confirms with the expected toast and re-reads the list", async () => {
    fireEvent.click(openConfirm());

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Invitation resent successfully."),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("closes the dialog on success", async () => {
    fireEvent.click(openConfirm());

    await waitFor(() => expect(screen.queryByText("Resend invitation?")).toBeNull());
  });

  it("titles a rate limit differently from a conflict", async () => {
    /*
     * The five states the operator has to be able to tell apart are: sending,
     * sent, rate limited, already registered, and something else. The first two
     * are covered above; these are the rest, and they must not all read as one
     * generic failure.
     */
    resendInviteAction.mockResolvedValue({
      ok: false,
      message:
        "Too many invitation emails have been sent recently. Please wait a few minutes and try again.",
      code: "EXTERNAL_SERVICE_ERROR",
    });

    fireEvent.click(openConfirm());
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    const [title, options] = toastError.mock.calls[0] as [string, { description: string }];

    expect(title).toBe("Invitation not sent");
    expect(options.description).toContain("wait a few minutes");
  });

  it("titles an already-registered address as a conflict", async () => {
    resendInviteAction.mockResolvedValue({
      ok: false,
      message:
        "That address is already registered in Supabase, so no new invitation can be sent to it.",
      code: "CONFLICT",
    });

    fireEvent.click(openConfirm());
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    expect((toastError.mock.calls[0] as [string, unknown])[0]).toBe("Already registered");
  });

  it("titles a rejected address distinctly", async () => {
    resendInviteAction.mockResolvedValue({
      ok: false,
      message: "Supabase rejected that email address.",
      code: "VALIDATION_ERROR",
    });

    fireEvent.click(openConfirm());
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    expect((toastError.mock.calls[0] as [string, unknown])[0]).toBe("Address rejected");
  });

  it("falls back to a generic title for an unrecognised code", async () => {
    resendInviteAction.mockResolvedValue({ ok: false, message: "nope", code: "UNEXPECTED_ERROR" });

    fireEvent.click(openConfirm());
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    expect((toastError.mock.calls[0] as [string, unknown])[0]).toBe(
      "Could not resend the invitation",
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("clears the loading state after a failure, not only after success", async () => {
    /*
     * A mutation that stays pending on error leaves a permanently disabled
     * button and no way to retry.
     */
    resendInviteAction.mockResolvedValue({ ok: false, message: "nope", code: "UNEXPECTED_ERROR" });

    fireEvent.click(openConfirm());

    await waitFor(() => expect(toastError).toHaveBeenCalled());

    const trigger = screen.getByLabelText("Resend invitation to invited@example.com");
    expect(trigger.hasAttribute("disabled")).toBe(false);
  });

  it("does not refresh the list when the send failed", async () => {
    resendInviteAction.mockResolvedValue({ ok: false, message: "nope", code: "UNEXPECTED_ERROR" });

    fireEvent.click(openConfirm());

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });
});
