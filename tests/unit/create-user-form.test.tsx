/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The Create User form (M02).
 *
 * What the browser must do with a password: mask it by default, let the
 * operator check what they typed, and never leave it in the field — not after
 * a refusal, not after success. And the form must send exactly the four fields
 * and move on to the Users list when the server accepts them.
 */

const PASSWORD = "Browser-Side-Secret-77";

const createUserAction = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock("@/modules/users/actions/user.actions", () => ({
  createUserAction: (input: unknown) => createUserAction(input),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (m: string, o?: { description?: string }) => toastSuccess(m, o),
    error: (m: string, o?: { description?: string }) => toastError(m, o),
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const { CreateUserForm } = await import("@/modules/users/components/create-user-form");

function renderForm(props: Partial<Parameters<typeof CreateUserForm>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <CreateUserForm
        assignableRoles={["worker", "super_admin"]}
        passwordMinLength={12}
        creationConfigured
        {...props}
      />
    </QueryClientProvider>,
  );
}

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

function fillValid() {
  fireEvent.change(field(/full name/i), { target: { value: "Amina Belkacem" } });
  fireEvent.change(field(/^email/i), { target: { value: "amina@example.com" } });
  fireEvent.change(field(/^password/i), { target: { value: PASSWORD } });
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /create user/i }));
}

beforeEach(() => {
  createUserAction.mockReset().mockResolvedValue({
    ok: true,
    data: { id: "new-1", email: "amina@example.com", role: "worker", status: "active" },
  });
  for (const m of [toastSuccess, toastError, push, refresh]) m.mockReset();
});

afterEach(cleanup);

describe("the fields", () => {
  it("has Name, Email, Password, Role and a Create User button", () => {
    renderForm();

    expect(field(/full name/i)).toBeTruthy();
    expect(field(/^email/i)).toBeTruthy();
    expect(field(/^password/i)).toBeTruthy();
    expect(screen.getByLabelText(/^role/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /create user/i })).toBeTruthy();
  });

  it("masks the password by default, and the toggle shows and hides it", () => {
    renderForm();

    expect(field(/^password/i).type).toBe("password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(field(/^password/i).type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(field(/^password/i).type).toBe("password");
  });

  it("states the configured minimum length", () => {
    renderForm({ passwordMinLength: 16 });

    expect(screen.getByText("At least 16 characters.")).toBeTruthy();
  });

  it("defaults the role to Worker, the least privileged", () => {
    renderForm();

    expect(screen.getByLabelText(/^role/i).textContent).toContain("Worker");
  });

  it("is disabled, with an explanation, when the service role key is missing", () => {
    renderForm({ creationConfigured: false });

    expect(screen.getByText("User creation not configured")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /create user/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("validation in the browser", () => {
  it("shows messages and sends nothing for an empty form", async () => {
    renderForm();
    submit();

    expect(await screen.findByText("Name is required")).toBeTruthy();
    expect(screen.getByText("Email is required")).toBeTruthy();
    expect(screen.getByText("Use at least 12 characters")).toBeTruthy();
    expect(createUserAction).not.toHaveBeenCalled();
  });

  it("refuses a malformed email and a short password", async () => {
    renderForm();
    fireEvent.change(field(/full name/i), { target: { value: "Amina" } });
    fireEvent.change(field(/^email/i), { target: { value: "not-an-email" } });
    fireEvent.change(field(/^password/i), { target: { value: "short" } });
    submit();

    expect(await screen.findByText("Enter a valid email address")).toBeTruthy();
    expect(screen.getByText("Use at least 12 characters")).toBeTruthy();
    expect(createUserAction).not.toHaveBeenCalled();
  });
});

describe("submitting", () => {
  it("sends the four fields, then returns to the Users list", async () => {
    renderForm();
    fillValid();
    submit();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/users"));
    expect(createUserAction).toHaveBeenCalledWith({
      name: "Amina Belkacem",
      email: "amina@example.com",
      password: PASSWORD,
      role: "worker",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("does not show the password after success, and clears the field", async () => {
    renderForm();
    fillValid();
    submit();

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(JSON.stringify(toastSuccess.mock.calls)).not.toContain(PASSWORD);
    await waitFor(() => expect(field(/^password/i).value).toBe(""));
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it("shows the server's field error and clears the password after a refusal", async () => {
    createUserAction.mockResolvedValue({
      ok: false,
      code: "VALIDATION_ERROR",
      message: "Please check the information you entered and try again.",
      fieldErrors: { password: "Supabase rejected that password as too weak." },
    });

    renderForm();
    fillValid();
    submit();

    expect(await screen.findByText("Supabase rejected that password as too weak.")).toBeTruthy();
    await waitFor(() => expect(field(/^password/i).value).toBe(""));
    expect(push).not.toHaveBeenCalled();
    /* The other fields survive, so the operator only retypes the password. */
    expect(field(/^email/i).value).toBe("amina@example.com");
  });

  it("toasts a refusal that belongs to no field, and stays on the form", async () => {
    createUserAction.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      message: "That email address is already registered. Each user needs their own address.",
    });

    renderForm();
    fillValid();
    submit();

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not create user", {
        description: "That email address is already registered. Each user needs their own address.",
      }),
    );
    expect(push).not.toHaveBeenCalled();
    expect(field(/^password/i).value).toBe("");
  });

  it("masks the password again after a submission, even if it was shown", async () => {
    renderForm();
    fillValid();
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    submit();

    await waitFor(() => expect(field(/^password/i).type).toBe("password"));
  });
});
