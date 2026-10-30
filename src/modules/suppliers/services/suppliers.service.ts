import "server-only";

import { eq } from "drizzle-orm";

import { PERMISSIONS, roleHasPermission, type Permission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { databaseAdapter, type Page } from "@/lib/database";
import { accounts, type AccountRow, type SupplierRow } from "@/lib/drizzle/schema";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { toAccountView, type AccountView } from "@/modules/accounts";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  suppliersRepository,
  type SupplierFilter,
  type SupplierMetrics,
  type SupplierWithCounts,
} from "../repositories/suppliers.repository";
import {
  assignSupplierSchema,
  createSupplierSchema,
  updateSupplierSchema,
} from "../validation/supplier.schema";

/**
 * Suppliers (M09B).
 *
 * Who an account came from. Reads are open to any signed-in CRM user who holds
 * `view_suppliers`; every write needs `manage_suppliers`, checked on the server
 * before anything is read — hiding the navigation entry is not a control.
 *
 * Accounts leave this module as `AccountView`, which drops the encrypted
 * password, so no supplier screen can become a way to read credentials.
 */

/** The browser's view of a supplier. No internal columns beyond what it shows. */
export interface SupplierListItem {
  readonly id: string;
  readonly name: string;
  readonly contact: string | null;
  readonly notes: string | null;
  readonly accountCount: number;
  readonly problemCount: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}

export interface SupplierAccountRow {
  readonly account: AccountView;
  readonly hasProblem: boolean;
}

export interface SupplierDetail extends SupplierListItem {
  readonly accounts: Page<SupplierAccountRow>;
}

export interface SuppliersOverview {
  readonly metrics: SupplierMetrics;
  readonly suppliers: Page<SupplierListItem>;
  /** Supplied accounts with no supplier recorded — shown for triage. */
  readonly unassigned: readonly AccountView[];
}

const UNASSIGNED_SHOWN = 50;

function requirePermissionFor(
  actor: AppUser | null,
  permission: Permission,
  action: string,
): Result<AppUser> {
  if (!actor || !roleHasPermission(actor.role, permission)) {
    return fail(
      new ForbiddenError(`Not permitted to ${action}`, {
        userMessage: "Suppliers are restricted to Super Admins.",
      }),
    );
  }

  return ok(actor);
}

function toItem(row: SupplierWithCounts): SupplierListItem {
  return {
    id: row.supplier.id,
    name: row.supplier.name,
    contact: row.supplier.contact,
    notes: row.supplier.notes,
    accountCount: row.accountCount,
    problemCount: row.problemCount,
    archivedAt: row.supplier.archivedAt ? row.supplier.archivedAt.toISOString() : null,
    createdAt: row.supplier.createdAt.toISOString(),
  };
}

/** The audit snapshot of a supplier. Nothing here is a secret. */
function snapshotOf(supplier: SupplierRow) {
  return {
    id: supplier.id,
    name: supplier.name,
    contact: supplier.contact,
    archivedAt: supplier.archivedAt,
    deletedAt: supplier.deletedAt,
  };
}

/** A duplicate name is the unique index firing; say so in the caller's words. */
function duplicateName(name: string): ConflictError {
  return new ConflictError(`Supplier name already exists: ${name}`, {
    userMessage: "A supplier with that name already exists.",
  });
}

async function overview(
  filter: SupplierFilter,
  actor: AppUser | null,
): Promise<Result<SuppliersOverview>> {
  const permitted = requirePermissionFor(actor, PERMISSIONS.VIEW_SUPPLIERS, "view suppliers");

  if (!permitted.ok) {
    return permitted;
  }

  const [metrics, list, unassigned] = await Promise.all([
    suppliersRepository.metrics(),
    suppliersRepository.list(filter),
    suppliersRepository.unassignedAccounts(UNASSIGNED_SHOWN),
  ]);

  if (!metrics.ok) return metrics;
  if (!list.ok) return list;
  if (!unassigned.ok) return unassigned;

  return ok({
    metrics: metrics.value,
    suppliers: { ...list.value, items: list.value.items.map(toItem) },
    unassigned: unassigned.value.map(toAccountView),
  });
}

async function detail(
  id: string,
  options: { readonly withProblemsOnly?: boolean; readonly offset?: number },
  actor: AppUser | null,
): Promise<Result<SupplierDetail>> {
  const permitted = requirePermissionFor(actor, PERMISSIONS.VIEW_SUPPLIERS, "view a supplier");

  if (!permitted.ok) {
    return permitted;
  }

  const found = await suppliersRepository.findById(id);

  if (!found.ok) return found;

  if (!found.value) {
    return fail(new NotFoundError("Supplier not found"));
  }

  const rows = await suppliersRepository.accountsFor(id, {
    withProblemsOnly: options.withProblemsOnly,
    offset: options.offset,
  });

  if (!rows.ok) return rows;

  return ok({
    ...toItem(found.value),
    accounts: {
      ...rows.value,
      items: rows.value.items.map((row) => ({
        account: toAccountView(row.account),
        hasProblem: row.hasProblem,
      })),
    },
  });
}

/**
 * The supplier figures alone, for the dashboard.
 *
 * `overview` already returns these, but it also reads the list and the triage
 * queue. The dashboard needs five numbers, so it asks for five numbers.
 */
async function metrics(actor: AppUser | null): Promise<Result<SupplierMetrics>> {
  const permitted = requirePermissionFor(
    actor,
    PERMISSIONS.VIEW_SUPPLIERS,
    "view supplier metrics",
  );

  return permitted.ok ? suppliersRepository.metrics() : permitted;
}

/** Live suppliers for the account form's picker. */
async function options(
  actor: AppUser | null,
): Promise<Result<readonly { readonly id: string; readonly name: string }[]>> {
  const permitted = requirePermissionFor(actor, PERMISSIONS.VIEW_SUPPLIERS, "list suppliers");

  return permitted.ok ? suppliersRepository.options() : permitted;
}

async function create(input: unknown, context: AuditContext): Promise<Result<SupplierListItem>> {
  const permitted = requirePermissionFor(
    context.actor,
    PERMISSIONS.MANAGE_SUPPLIERS,
    "create a supplier",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = createSupplierSchema.safeParse(input);

  if (!parsed.success) {
    return fail(
      new ValidationError("Supplier failed validation", {
        fieldErrors: { name: parsed.error.issues[0]?.message ?? "Enter the supplier's name" },
      }),
    );
  }

  const created = await suppliersRepository.create({
    name: parsed.data.name,
    ...(parsed.data.contact ? { contact: parsed.data.contact } : {}),
    ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
    createdBy: context.actor?.id ?? null,
  });

  if (!created.ok) {
    return created.error instanceof ConflictError ? fail(duplicateName(parsed.data.name)) : created;
  }

  await auditService.recordOrWarn(
    {
      entity: "supplier",
      entityId: created.value.id,
      action: "create",
      after: snapshotOf(created.value),
    },
    context,
  );

  return ok(toItem({ supplier: created.value, accountCount: 0, problemCount: 0 }));
}

async function update(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<SupplierListItem>> {
  const permitted = requirePermissionFor(
    context.actor,
    PERMISSIONS.MANAGE_SUPPLIERS,
    "edit a supplier",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = updateSupplierSchema.safeParse(input);

  if (!parsed.success) {
    return fail(new ValidationError("Supplier update failed validation"));
  }

  const before = await suppliersRepository.findById(id);

  if (!before.ok) return before;

  if (!before.value) {
    return fail(new NotFoundError("Supplier not found"));
  }

  const { archived, ...fields } = parsed.data;

  const updated = await suppliersRepository.update(id, {
    ...fields,
    ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
  });

  if (!updated.ok) {
    return updated.error instanceof ConflictError && fields.name
      ? fail(duplicateName(fields.name))
      : updated;
  }

  if (!updated.value) {
    return fail(new NotFoundError("Supplier not found"));
  }

  await auditService.recordOrWarn(
    {
      entity: "supplier",
      entityId: id,
      action: "update",
      before: snapshotOf(before.value.supplier),
      after: snapshotOf(updated.value),
    },
    context,
  );

  return ok(
    toItem({
      supplier: updated.value,
      accountCount: before.value.accountCount,
      problemCount: before.value.problemCount,
    }),
  );
}

/**
 * Removes a supplier, but never one that accounts still name.
 *
 * The foreign key is ON DELETE RESTRICT, so the database would refuse a hard
 * delete anyway; this refuses first, inside the transaction that counts, with
 * a message naming how many accounts must be reassigned. The row is then
 * soft-deleted like an account rather than erased, so the audit trail still
 * resolves the name.
 */
async function remove(id: string, context: AuditContext): Promise<Result<true>> {
  const permitted = requirePermissionFor(
    context.actor,
    PERMISSIONS.MANAGE_SUPPLIERS,
    "delete a supplier",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const outcome = await databaseAdapter.transaction("suppliers.remove", async (executor) => {
    const existing = await suppliersRepository.findRow(executor, id);

    if (!existing) {
      throw new NotFoundError("Supplier not found");
    }

    const held = await suppliersRepository.countAccounts(executor, id);

    if (held > 0) {
      throw new ConflictError(`Supplier still has ${held} account(s)`, {
        userMessage:
          `This supplier still has ${held} account${held === 1 ? "" : "s"}. ` +
          "Reassign them to another supplier first, or archive this one instead.",
      });
    }

    const deleted = await suppliersRepository.softDelete(executor, id);

    if (!deleted) {
      throw new NotFoundError("Supplier not found");
    }

    return { before: existing, after: deleted };
  });

  if (!outcome.ok) {
    return outcome;
  }

  await auditService.recordOrWarn(
    {
      entity: "supplier",
      entityId: id,
      action: "delete",
      before: snapshotOf(outcome.value.before),
      after: snapshotOf(outcome.value.after),
    },
    context,
  );

  return ok(true);
}

/**
 * Sets where an account came from, and which supplier when it came from one.
 *
 * The only path that writes `accounts.ownership` outside account creation. It
 * verifies the supplier exists and is live rather than trusting an id from the
 * browser — the foreign key would catch a fabricated one, but a deleted
 * supplier would otherwise be silently acceptable.
 */
async function assign(input: unknown, context: AuditContext): Promise<Result<AccountView>> {
  const permitted = requirePermissionFor(
    context.actor,
    PERMISSIONS.MANAGE_SUPPLIERS,
    "assign a supplier",
  );

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = assignSupplierSchema.safeParse(input);

  if (!parsed.success) {
    return fail(
      new ValidationError("Supplier assignment failed validation", {
        userMessage: "That supplier assignment was not valid.",
      }),
    );
  }

  const { accountId, ownership } = parsed.data;
  const supplierId = ownership.ownership === "supplied" ? ownership.supplierId : null;

  const outcome = await databaseAdapter.transaction("suppliers.assign", async (executor) => {
    const [before] = await executor
      .select()
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .for("update");

    if (!before || before.deletedAt) {
      throw new NotFoundError("Account not found");
    }

    if (supplierId !== null) {
      const supplier = await suppliersRepository.findRow(executor, supplierId);

      if (!supplier) {
        throw new ValidationError("Supplier not found", {
          userMessage: "That supplier no longer exists. Choose another.",
        });
      }
    }

    const [after] = await executor
      .update(accounts)
      .set({ ownership: ownership.ownership, supplierId, updatedAt: new Date() })
      .where(eq(accounts.id, accountId))
      .returning();

    if (!after) {
      throw new ConflictError("The account could not be updated");
    }

    return { before, after };
  });

  if (!outcome.ok) {
    return outcome;
  }

  await auditService.recordOrWarn(
    {
      entity: "account",
      entityId: accountId,
      action: "update",
      before: {
        event: "supplier_assigned",
        ownership: outcome.value.before.ownership,
        supplierId: outcome.value.before.supplierId,
      },
      after: {
        event: "supplier_assigned",
        ownership: outcome.value.after.ownership,
        supplierId: outcome.value.after.supplierId,
      },
    },
    context,
  );

  return ok(toAccountView(outcome.value.after));
}

export const suppliersService = {
  overview,
  detail,
  metrics,
  options,
  create,
  update,
  remove,
  assign,
} as const;

export type { AccountRow };
