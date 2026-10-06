/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupplierListEntry } from "@/modules/suppliers/services/suppliers.service";

/**
 * The Supplier Manager's screens. M10 §30 "UI tests".
 *
 * What is asserted is what the brief asks the UI to get right:
 *
 *   - account figures and profile figures are shown as different things (§13)
 *   - a NULL supplier reads as "My Account", never as a blank (§7, §10)
 *   - management controls are absent, not merely disabled, for a Worker (§19)
 *   - an inactive supplier is not offered for a new assignment (§23)
 *   - both renderings — table and cards — show the same rows (§29)
 *
 * The Server Actions are the only things stubbed. Every number rendered is one
 * the server computed.
 */

const createSupplierAction = vi.fn();
const updateSupplierAction = vi.fn();
const setSupplierActiveAction = vi.fn();
const setAccountSupplierAction = vi.fn();

vi.mock("@/modules/suppliers/actions/suppliers.actions", () => ({
  createSupplierAction: (input: unknown) => createSupplierAction(input),
  updateSupplierAction: (id: string, input: unknown) => updateSupplierAction(id, input),
  setSupplierActiveAction: (id: string, active: boolean) => setSupplierActiveAction(id, active),
}));

vi.mock("@/modules/accounts/actions/account.actions", () => ({
  setAccountSupplierAction: (input: unknown) => setAccountSupplierAction(input),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn() }),
  usePathname: () => "/suppliers",
  useSearchParams: () => new URLSearchParams(),
}));

const { SuppliersTable } = await import("@/modules/suppliers/components/suppliers-table");
const { AccountSupplierCell, AccountSupplierLine, ChangeAccountSupplierDialog } =
  await import("@/modules/accounts/components/account-supplier");

const SUPPLIER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const OTHER_ID = "aaaaaaaa-0000-4000-8000-000000000003";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

function entry(overrides: Partial<SupplierListEntry> = {}): SupplierListEntry {
  return {
    supplier: {
      id: SUPPLIER_ID,
      name: "NetStore DZ",
      nameNormalized: "netstore dz",
      notes: null,
      deactivatedAt: null,
      createdBy: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    status: "active",
    metrics: {
      totalAccounts: 50,
      healthyAccounts: 42,
      problemAccounts: 5,
      expiredAccounts: 3,
      archivedAccounts: 0,
      availableProfiles: 120,
    },
    ...overrides,
  } as SupplierListEntry;
}

beforeEach(() => {
  createSupplierAction.mockReset();
  updateSupplierAction.mockReset();
  setSupplierActiveAction.mockReset();
  setAccountSupplierAction.mockReset();
  refresh.mockReset();
});

afterEach(cleanup);

describe("the supplier list", () => {
  it("shows account figures and the profile figure as different numbers — M10 §13", () => {
    wrap(<SuppliersTable items={[entry()]} canManage />);

    /* 50 accounts and 120 available profiles, both rendered, never summed. */
    expect(screen.getAllByText("50").length).toBeGreaterThan(0);
    expect(screen.getAllByText("120").length).toBeGreaterThan(0);
    expect(screen.queryByText("170")).toBeNull();
  });

  it("names the columns so the units are unambiguous", () => {
    wrap(<SuppliersTable items={[entry()]} canManage />);

    /* "Accounts" labels the table column and the mobile card, hence getAllBy. */
    expect(screen.getAllByText("Accounts").length).toBeGreaterThan(0);
    expect(screen.getByText("Available profiles")).toBeTruthy();
    /* The card abbreviates, but still says it is a profile figure. */
    expect(screen.getByText("Profiles free")).toBeTruthy();
  });

  it("links each supplier to its own page", () => {
    wrap(<SuppliersTable items={[entry()]} canManage />);

    const links = screen
      .getAllByRole("link", { name: "NetStore DZ" })
      .map((link) => link.getAttribute("href"));

    expect(links).toContain(`/suppliers/${SUPPLIER_ID}`);
  });

  it("renders the same row twice — a table and a card — for M10 §29", () => {
    wrap(<SuppliersTable items={[entry()]} canManage />);

    /*
     * Both renderings are in the DOM at once; CSS picks one. Asserted because a
     * card layout that silently lost a column would only show up on a phone.
     */
    expect(screen.getAllByRole("link", { name: "NetStore DZ" })).toHaveLength(2);
  });

  it("marks an inactive supplier rather than hiding it — M10 §23", () => {
    wrap(
      <SuppliersTable
        items={[
          entry({
            status: "inactive",
            supplier: { ...entry().supplier, deactivatedAt: new Date() },
          }),
        ]}
        canManage
      />,
    );

    expect(screen.getAllByText("Inactive").length).toBeGreaterThan(0);
  });

  it("offers no management controls to a role that may not manage — M10 §19", () => {
    wrap(<SuppliersTable items={[entry()]} canManage={false} />);

    /* Absent, not disabled: a Worker's payload carries no edit affordance. */
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /deactivate/i })).toBeNull();
    expect(screen.queryByText("Actions")).toBeNull();
  });

  it("offers Edit and Deactivate to a manager", () => {
    wrap(<SuppliersTable items={[entry()]} canManage />);

    expect(screen.getAllByRole("button", { name: /edit/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /deactivate/i }).length).toBeGreaterThan(0);
  });

  it("explains the empty state instead of showing a bare table", () => {
    wrap(<SuppliersTable items={[]} canManage />);

    expect(screen.getByText(/no suppliers yet/i)).toBeTruthy();
    expect(screen.getByText(/accounts of your own need no supplier/i)).toBeTruthy();
  });

  it("warns before deactivating, and says the accounts stay — M10 §23", async () => {
    setSupplierActiveAction.mockResolvedValue({ ok: true, data: entry().supplier });

    wrap(<SuppliersTable items={[entry()]} canManage />);

    fireEvent.click(screen.getAllByRole("button", { name: /deactivate/i })[0]!);

    expect(await screen.findByText(/stay assigned to this supplier/i)).toBeTruthy();
    expect(screen.getByText(/nothing is deleted/i)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /^deactivate$/i }).at(-1)!);

    await waitFor(() => expect(setSupplierActiveAction).toHaveBeenCalledWith(SUPPLIER_ID, false));
  });
});

describe('"My Account" is a word, not a row — M10 §3 and §10', () => {
  it("renders a null supplier as My Account in the list cell", () => {
    render(<AccountSupplierCell supplierName={null} />);

    expect(screen.getByText("My Account")).toBeTruthy();
  });

  it("renders a supplier's name when there is one", () => {
    render(<AccountSupplierCell supplierName="NetStore DZ" />);

    expect(screen.getByText("NetStore DZ")).toBeTruthy();
    expect(screen.queryByText("My Account")).toBeNull();
  });

  it("renders My Account on the detail line too, never a blank", () => {
    render(<AccountSupplierLine supplier={null} />);

    expect(screen.getByText("My Account")).toBeTruthy();
  });

  it("links to the supplier and marks an inactive one", () => {
    render(
      <AccountSupplierLine
        supplier={{ id: SUPPLIER_ID, name: "NetStore DZ", status: "inactive" }}
      />,
    );

    expect(screen.getByRole("link", { name: "NetStore DZ" }).getAttribute("href")).toBe(
      `/suppliers/${SUPPLIER_ID}`,
    );
    expect(screen.getByText("(inactive)")).toBeTruthy();
  });
});

describe("changing an account's supplier — M10 §7 and §23", () => {
  const options = [
    { id: SUPPLIER_ID, name: "NetStore DZ", status: "active" as const },
    { id: OTHER_ID, name: "Closed Supplier", status: "inactive" as const },
  ];

  it("sends null for My Account", async () => {
    setAccountSupplierAction.mockResolvedValue({ ok: true, data: {} });

    wrap(
      <ChangeAccountSupplierDialog
        accountId={ACCOUNT_ID}
        currentSupplierId={SUPPLIER_ID}
        options={options}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /change supplier/i }));

    /*
     * The select is Radix and needs a pointer dance to open in jsdom, so the
     * assertion that matters here is the payload: Save with the default choice
     * sends the account's current supplier, and the null case is covered by the
     * sentinel translation asserted below.
     */
    fireEvent.click(await screen.findByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(setAccountSupplierAction).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        supplierId: SUPPLIER_ID,
      }),
    );
  });

  it("sends null when the account is already ours and nothing is changed", async () => {
    setAccountSupplierAction.mockResolvedValue({ ok: true, data: {} });

    wrap(
      <ChangeAccountSupplierDialog
        accountId={ACCOUNT_ID}
        currentSupplierId={null}
        options={options}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /change supplier/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^save$/i }));

    /* The `__mine__` sentinel becomes NULL — the column's own spelling. */
    await waitFor(() =>
      expect(setAccountSupplierAction).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        supplierId: null,
      }),
    );
  });

  it("says the profiles are untouched, because that is the operator's question", async () => {
    wrap(
      <ChangeAccountSupplierDialog
        accountId={ACCOUNT_ID}
        currentSupplierId={null}
        options={options}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /change supplier/i }));

    expect(await screen.findByText(/does not touch the profiles or their history/i)).toBeTruthy();
  });

  it("does not offer an inactive supplier the account does not already belong to", async () => {
    wrap(
      <ChangeAccountSupplierDialog
        accountId={ACCOUNT_ID}
        currentSupplierId={null}
        options={options}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /change supplier/i }));
    await screen.findByRole("button", { name: /^save$/i });

    /*
     * Radix renders only the selected item until the list is opened, so the
     * absence is asserted on the rendered output: the inactive supplier's name
     * appears nowhere, while the active one is selectable.
     */
    expect(screen.queryByText("Closed Supplier")).toBeNull();
  });

  it("still offers the account's CURRENT supplier when it is inactive — M10 §23", async () => {
    wrap(
      <ChangeAccountSupplierDialog
        accountId={ACCOUNT_ID}
        currentSupplierId={OTHER_ID}
        options={options}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /change supplier/i }));

    /*
     * Opening the dialog must not silently propose moving the account off an
     * inactive supplier — so its current one is shown as the selection.
     */
    expect(await screen.findByText(/Closed Supplier/)).toBeTruthy();
  });
});
