import "server-only";

import { PERMISSIONS, roleHasPermission } from "@/config/roles";
import type { AppUser } from "@/lib/auth";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import type { SupplierRow } from "@/lib/drizzle/schema";
import { auditService, type AuditContext } from "@/modules/audit";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  suppliersRepository,
  type OwnershipCounts,
  type SupplierMetrics,
  type SupplierWithMetrics,
} from "../repositories/suppliers.repository";
import { cleanSupplierName, normalizeSupplierName } from "./supplier-name";
import { acceptsNewAccounts, deriveSupplierStatus, type SupplierStatus } from "./supplier-status";
import {
  supplierCreateSchema,
  supplierFilterSchema,
  supplierUpdateSchema,
} from "../validation/supplier.schema";

/**
 * Suppliers service. M10.
 *
 * Owns who may see a supplier, who may change one, and the audit trail for
 * every change.
 *
 * TWO PERMISSIONS, AND THE SPLIT IS THE POINT
 *
 *   VIEW_SUPPLIERS    Super Admin and Worker. A Worker must see which supplier
 *                     an account came from to do their job.
 *   MANAGE_SUPPLIERS  Super Admin only. Creating, renaming, deactivating — and
 *                     assigning an account's supplier, which is the same
 *                     administrative act from the other side, because it
 *                     decides what every supplier metric says.
 *
 * Both are checked HERE, on every entry point including the reads. M10 §19 and
 * §26: a Server Action is a POST endpoint anybody holding a session can call,
 * and hiding a button is not authorization. The RLS policies on `suppliers`
 * say the same thing independently (read: `is_crm_user`, write:
 * `is_super_admin`), so a direct PostgREST call is refused too.
 *
 * NO METRIC IS DEFINED HERE. The repository composes them from
 * `lib/drizzle/predicates`, which is where the accounts list, the dashboard and
 * the allocation engine get the same rules. M10 §12 and §16.
 */

/** A supplier as a browser sees it: the row plus its derived status. */
export interface SupplierView {
  readonly supplier: SupplierRow;
  readonly status: SupplierStatus;
}

export interface SupplierListEntry extends SupplierView {
  readonly metrics: SupplierMetrics;
}

/** M10 §11: a supplier, its figures, and how many accounts it still owns. */
export interface SupplierDetail extends SupplierView {
  readonly metrics: SupplierMetrics;
}

/** An option in the account form's supplier picker. M10 §7. */
export interface SupplierOption {
  readonly id: string;
  readonly name: string;
  readonly status: SupplierStatus;
}

/* ------------------------------------------------------------ authorization */

function requireViewer(context: AuditContext): Result<AppUser> {
  const actor = context.actor;

  if (!actor) {
    return fail(
      new ForbiddenError("No signed-in user for a supplier read", {
        userMessage: "Sign in to view suppliers.",
      }),
    );
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.VIEW_SUPPLIERS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not view suppliers`, {
        userMessage: "You do not have permission to view suppliers.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  return ok(actor);
}

function requireManager(context: AuditContext): Result<AppUser> {
  const actor = context.actor;

  if (!actor) {
    return fail(
      new ForbiddenError("No signed-in user for a supplier change", {
        userMessage: "Sign in to manage suppliers.",
      }),
    );
  }

  if (!roleHasPermission(actor.role, PERMISSIONS.MANAGE_SUPPLIERS)) {
    return fail(
      new ForbiddenError(`Role ${actor.role} may not manage suppliers`, {
        userMessage: "You do not have permission to manage suppliers.",
        context: { actorId: actor.id, role: actor.role },
      }),
    );
  }

  return ok(actor);
}

/**
 * The permission an account's supplier assignment requires.
 *
 * Exported so `accountsService` applies the IDENTICAL check when an account is
 * created with a supplier, rather than writing a second one that could drift.
 * M10 §7 and §22: ownership is supplier management, wherever it is set from.
 */
export function assertMayAssignSupplier(context: AuditContext): Result<AppUser> {
  return requireManager(context);
}

/* ------------------------------------------------------------------- errors */

function toValidationError(
  issues: readonly { path: PropertyKey[]; message: string }[],
): ValidationError {
  const fieldErrors: Record<string, string> = {};

  for (const issue of issues) {
    const field = issue.path[0];

    if (typeof field === "string" && !(field in fieldErrors)) {
      fieldErrors[field] = issue.message;
    }
  }

  return new ValidationError("Supplier input failed validation", { fieldErrors });
}

/**
 * The refusal for a name already taken.
 *
 * Rendered on the name input, which is why it is a ValidationError with a field
 * error rather than a ConflictError: the operator typed it and has to see the
 * message there. The unique index is still the guarantee — this is the friendly
 * path to the same answer.
 */
function duplicateName(name: string): ValidationError {
  return new ValidationError(`Supplier name already in use: ${name}`, {
    userMessage: `A supplier called "${name}" already exists.`,
    fieldErrors: { name: "A supplier with this name already exists" },
  });
}

function notFound(): NotFoundError {
  return new NotFoundError("Supplier not found", {
    userMessage: "That supplier no longer exists.",
  });
}

function view(supplier: SupplierRow): SupplierView {
  return { supplier, status: deriveSupplierStatus(supplier) };
}

/* -------------------------------------------------------------------- reads */

/** Every supplier with its metrics. M10 §11, §17, §18. */
async function listSuppliers(
  input: unknown,
  context: AuditContext,
): Promise<Result<readonly SupplierListEntry[]>> {
  const permitted = requireViewer(context);

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = supplierFilterSchema.safeParse(input ?? {});

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const rows = await suppliersRepository.listWithMetrics(parsed.data);

  if (!rows.ok) {
    return rows;
  }

  return ok(rows.value.map((row: SupplierWithMetrics) => ({ ...view(row.supplier), ...row })));
}

/** One supplier and its figures. M10 §11. */
async function getSupplier(id: string, context: AuditContext): Promise<Result<SupplierDetail>> {
  const permitted = requireViewer(context);

  if (!permitted.ok) {
    return permitted;
  }

  const found = await suppliersRepository.findById(id);

  if (!found.ok) {
    return found;
  }

  if (!found.value) {
    return fail(notFound());
  }

  const metrics = await suppliersRepository.metricsFor(id);

  if (!metrics.ok) {
    return metrics;
  }

  return ok({ ...view(found.value), metrics: metrics.value });
}

/**
 * Suppliers for a picker.
 *
 * Carries the status so the form can mark an inactive supplier and refuse to
 * offer it for a NEW assignment — while still naming it on an account that
 * already belongs to it (M10 §23).
 */
async function listOptions(context: AuditContext): Promise<Result<readonly SupplierOption[]>> {
  const permitted = requireViewer(context);

  if (!permitted.ok) {
    return permitted;
  }

  const rows = await suppliersRepository.listOptions();

  if (!rows.ok) {
    return rows;
  }

  return ok(
    rows.value.map((supplier) => ({
      id: supplier.id,
      name: supplier.name,
      status: deriveSupplierStatus(supplier),
    })),
  );
}

/** My Accounts against supplier accounts. M10 §15. */
async function ownership(context: AuditContext): Promise<Result<OwnershipCounts>> {
  const permitted = requireViewer(context);

  return permitted.ok ? suppliersRepository.ownership() : permitted;
}

/* ------------------------------------------------------------------- writes */

/** Creates a supplier. M10 §6. */
async function createSupplier(input: unknown, context: AuditContext): Promise<Result<SupplierRow>> {
  const permitted = requireManager(context);

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = supplierCreateSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const name = cleanSupplierName(parsed.data.name);
  const nameNormalized = normalizeSupplierName(name);

  /*
   * Checked before the insert so the operator gets a message on the field. The
   * unique index remains the guarantee: two operators creating the same name at
   * once both pass this read, and the second insert is refused by the database.
   * That refusal surfaces as a conflict rather than a field error, which is
   * honest — by then it genuinely is a race and not a typo.
   */
  const existing = await suppliersRepository.findByNormalizedName(nameNormalized);

  if (!existing.ok) {
    return existing;
  }

  if (existing.value) {
    return fail(duplicateName(existing.value.name));
  }

  const created = await suppliersRepository.create({
    name,
    nameNormalized,
    notes: parsed.data.notes?.trim() ? parsed.data.notes.trim() : null,
    createdBy: permitted.value.id,
  });

  if (!created.ok) {
    return created;
  }

  await auditService.recordOrWarn(
    {
      entity: "supplier",
      entityId: created.value.id,
      action: "create",
      after: { ...created.value, event: "supplier_created", supplierName: created.value.name },
    },
    context,
  );

  return created;
}

/** Renames a supplier or edits its note. M10 §6. */
async function updateSupplier(
  id: string,
  input: unknown,
  context: AuditContext,
): Promise<Result<SupplierRow>> {
  const permitted = requireManager(context);

  if (!permitted.ok) {
    return permitted;
  }

  const parsed = supplierUpdateSchema.safeParse(input);

  if (!parsed.success) {
    return fail(toValidationError(parsed.error.issues));
  }

  const before = await suppliersRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  if (!before.value) {
    return fail(notFound());
  }

  const name = parsed.data.name === undefined ? undefined : cleanSupplierName(parsed.data.name);
  const nameNormalized = name === undefined ? undefined : normalizeSupplierName(name);

  /* A rename onto another supplier's name is refused; renaming to its own is a no-op. */
  if (nameNormalized !== undefined && nameNormalized !== before.value.nameNormalized) {
    const clash = await suppliersRepository.findByNormalizedName(nameNormalized);

    if (!clash.ok) {
      return clash;
    }

    if (clash.value) {
      return fail(duplicateName(clash.value.name));
    }
  }

  const updated = await suppliersRepository.update(id, {
    ...(name === undefined ? {} : { name, nameNormalized }),
    /* An empty note is a cleared note, which is why "" is not treated as absent. */
    ...(parsed.data.notes === undefined
      ? {}
      : { notes: parsed.data.notes.trim() === "" ? null : parsed.data.notes.trim() }),
  });

  if (!updated.ok) {
    return updated;
  }

  const next = updated.value;

  if (!next) {
    return fail(notFound());
  }

  await auditService.recordOrWarn(
    {
      entity: "supplier",
      entityId: id,
      action: "update",
      before: before.value,
      after: { ...next, event: "supplier_updated", supplierName: next.name },
    },
    context,
  );

  return ok(next);
}

/**
 * Deactivates or reactivates a supplier. M10 §6 and §23.
 *
 * Deactivation is NOT deletion and does nothing to the accounts involved:
 * they stay linked, their supplier stays named on screen, and the supplier's
 * own page stays reachable. What changes is that no further account may be
 * assigned to it — enforced by `acceptsNewAccounts` wherever an assignment is
 * made, not by hiding it from the picker.
 *
 * There is deliberately no delete. M10 §6 and §24 prefer deactivation, the
 * foreign key is RESTRICT, and history that can be deleted is not history.
 */
async function setSupplierActive(
  id: string,
  active: boolean,
  context: AuditContext,
): Promise<Result<SupplierRow>> {
  const permitted = requireManager(context);

  if (!permitted.ok) {
    return permitted;
  }

  const before = await suppliersRepository.findById(id);

  if (!before.ok) {
    return before;
  }

  if (!before.value) {
    return fail(notFound());
  }

  /* Already in the requested state: answer with the row rather than writing again. */
  if (acceptsNewAccounts(before.value) === active) {
    return ok(before.value);
  }

  const updated = await suppliersRepository.setDeactivated(id, !active);

  if (!updated.ok) {
    return updated;
  }

  const next = updated.value;

  if (!next) {
    return fail(notFound());
  }

  /* How many accounts keep pointing at it, recorded because §23 is about them. */
  const accountCount = await suppliersRepository.countAccounts(id);

  await auditService.recordOrWarn(
    {
      entity: "supplier",
      entityId: id,
      action: active ? "restore" : "archive",
      before: before.value,
      after: {
        ...next,
        event: active ? "supplier_reactivated" : "supplier_deactivated",
        supplierName: next.name,
        count: accountCount.ok ? accountCount.value : undefined,
      },
    },
    context,
  );

  return ok(next);
}

/**
 * Whether this supplier may receive a NEW account, resolved for a caller that
 * holds only an id.
 *
 * Used by `accountsService` at both assignment points. Returns the row so the
 * caller can name the supplier in its own audit entry without a second read.
 */
async function requireAssignable(supplierId: string): Promise<Result<SupplierRow>> {
  const found = await suppliersRepository.findById(supplierId);

  if (!found.ok) {
    return found;
  }

  if (!found.value) {
    return fail(
      new ValidationError(`Unknown supplier ${supplierId}`, {
        userMessage: "That supplier does not exist.",
        fieldErrors: { supplierId: "Choose a supplier from the list" },
      }),
    );
  }

  if (!acceptsNewAccounts(found.value)) {
    return fail(
      new ConflictError(`Supplier ${supplierId} is inactive`, {
        userMessage: `"${found.value.name}" is inactive, so no further account can be assigned to it. Reactivate it first.`,
        context: { supplierId },
      }),
    );
  }

  return ok(found.value);
}

export const suppliersService = {
  listSuppliers,
  getSupplier,
  listOptions,
  ownership,
  createSupplier,
  updateSupplier,
  setSupplierActive,
  requireAssignable,
} as const;
