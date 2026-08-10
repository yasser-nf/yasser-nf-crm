import { sql } from "drizzle-orm";

import { databaseAdapter, type DatabaseExecutor, type DatabaseTransaction } from "@/lib/database";
import { ValidationError } from "@/lib/errors";
import type { Result } from "@/types/result";
import { fail, ok } from "@/utils/result";
import { BACKUP_TABLE_NAMES } from "../services/backup-format";

/**
 * Dataset repository.
 *
 * Reads and writes the actual business rows a backup contains. Table names are
 * dynamic here, which nothing else in the codebase does, so two rules apply
 * without exception:
 *
 *   1. Every table name is checked against BACKUP_TABLE_NAMES before it reaches
 *      SQL. A name that is not on that list never becomes an identifier.
 *   2. Identifiers go through `sql.identifier`, never string interpolation.
 *
 * A backup module that concatenated a table name into SQL would be a trivial
 * injection point reachable from an imported file.
 */

export type DatasetRow = Record<string, unknown>;

/** Rejects any table not on the allow-list. */
function assertBackupTable(table: string): Result<string> {
  if (!BACKUP_TABLE_NAMES.includes(table)) {
    return fail(
      new ValidationError(`Refusing to touch table "${table}": not part of a backup`, {
        userMessage: "The backup refers to data this system does not manage.",
      }),
    );
  }

  return ok(table);
}

async function columnsOf(executor: DatabaseExecutor, table: string): Promise<string[]> {
  const rows = await executor.execute(sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by ordinal_position
  `);

  return (rows as unknown as { column_name: string }[]).map((row) => row.column_name);
}

export interface DatasetRepository {
  countRows(table: string): Promise<Result<number>>;
  /** One page of rows, ordered by primary key so paging is stable. */
  readPage(table: string, offset: number, limit: number): Promise<Result<readonly DatasetRow[]>>;
  readAll(table: string): Promise<Result<readonly DatasetRow[]>>;
  /** Ids of Auth identities that still exist, for the orphan rule. */
  existingAuthUserIds(candidateIds: readonly string[]): Promise<Result<ReadonlySet<string>>>;
}

export const datasetRepository: DatasetRepository = {
  async countRows(table) {
    const allowed = assertBackupTable(table);

    if (!allowed.ok) {
      return allowed;
    }

    return databaseAdapter.query("dataset.countRows", async (executor) => {
      const rows = await executor.execute(
        sql`select count(*)::int as count from ${sql.identifier(table)}`,
      );

      return (rows as unknown as { count: number }[])[0]?.count ?? 0;
    });
  },

  async readPage(table, offset, limit) {
    const allowed = assertBackupTable(table);

    if (!allowed.ok) {
      return allowed;
    }

    return databaseAdapter.query("dataset.readPage", async (executor) => {
      /*
       * to_jsonb of the whole row, so every column arrives already converted to
       * a JSON-safe representation by PostgreSQL. Doing that conversion here in
       * JavaScript would mean re-implementing type mapping for timestamps,
       * numerics and jsonb — and getting one wrong silently corrupts a backup.
       */
      const rows = await executor.execute(sql`
        select to_jsonb(t) as row
        from ${sql.identifier(table)} t
        order by t.id
        limit ${limit} offset ${offset}
      `);

      return (rows as unknown as { row: DatasetRow }[]).map((entry) => entry.row);
    });
  },

  async readAll(table) {
    const allowed = assertBackupTable(table);

    if (!allowed.ok) {
      return allowed;
    }

    return databaseAdapter.query("dataset.readAll", async (executor) => {
      const rows = await executor.execute(sql`
        select to_jsonb(t) as row from ${sql.identifier(table)} t order by t.id
      `);

      return (rows as unknown as { row: DatasetRow }[]).map((entry) => entry.row);
    });
  },

  async existingAuthUserIds(candidateIds) {
    if (candidateIds.length === 0) {
      return ok(new Set<string>());
    }

    const result = await databaseAdapter.query("dataset.existingAuthUserIds", async (executor) => {
      /*
       * The id list travels as jsonb, not as a native array parameter. Drizzle's
       * `execute` does not serialise a JavaScript array into a PostgreSQL array
       * literal, so `= any($1::uuid[])` fails at bind time. Passing JSON and
       * unnesting it in SQL is the form that works through this driver, and is
       * the same technique the row writer uses.
       */
      const rows = await executor.execute(sql`
        select u.id::text as id
        from auth.users u
        join jsonb_array_elements_text(${JSON.stringify([...candidateIds])}::jsonb) as candidate(id)
          on u.id = candidate.id::uuid
      `);

      return (rows as unknown as { id: string }[]).map((row) => row.id);
    });

    if (!result.ok) {
      return result;
    }

    return ok(new Set(result.value));
  },
};

/**
 * Writes rows into a table, inside a caller-owned transaction.
 *
 * Deliberately not part of the repository interface above: it must run in the
 * restore transaction, so it takes the transaction rather than opening its own.
 * Calling it outside one would defeat the all-or-nothing guarantee.
 *
 * `jsonb_populate_recordset` does the type coercion in PostgreSQL, against the
 * table's own row type. That is why a backup can round-trip timestamps, numerics
 * and jsonb columns without this module knowing a single column type.
 */
export async function upsertRows(
  executor: DatabaseTransaction,
  table: string,
  rows: readonly DatasetRow[],
  mode: "reconcile" | "append_only",
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  const allowed = assertBackupTable(table);

  if (!allowed.ok) {
    throw allowed.error;
  }

  const columns = await columnsOf(executor, table);

  /*
   * Unknown keys in the file are dropped rather than rejected: a column removed
   * since the backup was taken is an ordinary migration, and refusing the whole
   * restore over it would make old backups unusable after any schema change.
   */
  const payload = rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => columns.includes(key))),
  );

  const assignable = columns.filter((column) => column !== "id");

  const updateClause = sql.join(
    assignable.map((column) => sql`${sql.identifier(column)} = excluded.${sql.identifier(column)}`),
    sql`, `,
  );

  const conflict =
    mode === "append_only"
      ? sql`on conflict (id) do nothing`
      : sql`on conflict (id) do update set ${updateClause}`;

  const inserted = await executor.execute(sql`
    insert into ${sql.identifier(table)}
    select * from jsonb_populate_recordset(null::${sql.identifier(table)}, ${JSON.stringify(payload)}::jsonb)
    ${conflict}
    returning id
  `);

  return (inserted as unknown as unknown[]).length;
}

/** Deletes rows by id, inside a caller-owned transaction. */
export async function deleteRows(
  executor: DatabaseTransaction,
  table: string,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }

  const allowed = assertBackupTable(table);

  if (!allowed.ok) {
    throw allowed.error;
  }

  /* jsonb rather than a native array parameter — see existingAuthUserIds. */
  const deleted = await executor.execute(sql`
    delete from ${sql.identifier(table)}
    where id in (
      select value::uuid from jsonb_array_elements_text(${JSON.stringify([...ids])}::jsonb) as t(value)
    )
    returning id
  `);

  return (deleted as unknown as unknown[]).length;
}

/** Current row ids, used to plan creates and deletes. */
export async function idsOf(
  executor: DatabaseExecutor,
  table: string,
): Promise<ReadonlySet<string>> {
  const allowed = assertBackupTable(table);

  if (!allowed.ok) {
    throw allowed.error;
  }

  const rows = await executor.execute(sql`select id::text as id from ${sql.identifier(table)}`);

  return new Set((rows as unknown as { id: string }[]).map((row) => row.id));
}
