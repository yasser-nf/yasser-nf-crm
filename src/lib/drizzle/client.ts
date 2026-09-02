import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { serverEnv } from "@/config/env.server";
import { poolOptions } from "./pool-config";
import * as schema from "./schema";

/**
 * Drizzle client.
 *
 * ADR-003: only the Database Adapter in `@/lib/database` may import this. ESLint
 * enforces that boundary — repositories importing Drizzle is an architecture
 * violation, not a style preference.
 *
 * The connection is created once per process and reused. Next.js re-evaluates
 * modules on every hot reload in development, which without the global cache
 * below would open a new pool on every file save until Postgres refuses new
 * connections.
 */

const globalForDatabase = globalThis as unknown as {
  __ynfCrmSqlClient?: ReturnType<typeof postgres>;
};

function createSqlClient(): ReturnType<typeof postgres> {
  return postgres(serverEnv.DATABASE_URL, poolOptions);
}

const sqlClient = globalForDatabase.__ynfCrmSqlClient ?? createSqlClient();

if (process.env.NODE_ENV !== "production") {
  globalForDatabase.__ynfCrmSqlClient = sqlClient;
}

export const drizzleClient = drizzle(sqlClient, { schema });

export type DrizzleClient = typeof drizzleClient;
