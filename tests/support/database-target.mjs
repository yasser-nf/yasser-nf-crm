/**
 * Decides which database the integration suite may use — and refuses production.
 *
 * Until M01.5 there was no decision at all: tests/setup/env.ts loaded
 * `.env.local`, whose DATABASE_URL is production, and the integration suite
 * wrote real rows there. This module is now the only place that answers the
 * question, and it is pure so the refusal itself is under test.
 *
 * THE RULE
 *
 *   - No TEST_DATABASE_URL           → integration tests are SKIPPED.
 *   - TEST_DATABASE_URL is localhost → allowed (the in-process PGlite server).
 *   - TEST_DATABASE_URL is remote    → refused, unless ALLOW_REMOTE_TEST_DATABASE
 *                                      names that exact host. This is the door
 *                                      for a future staging project, opened on
 *                                      purpose, one host at a time.
 *   - TEST_DATABASE_URL is production → refused ALWAYS, whatever else is set.
 *
 * "Production" is recognised three independent ways, so a URL written
 * differently still matches: the same host+port+database+user as the app's
 * DATABASE_URL, the same Supabase project ref, or a ref in the known list.
 *
 * Only safe identifiers are ever reported — a host or a project ref. Never a
 * URL, never a password.
 */

/** The placeholder the integration tests already recognise and skip on. */
export const PLACEHOLDER_DATABASE_URL =
  "postgresql://postgres:placeholder@placeholder.supabase.co:5432/postgres";

/** Supabase project refs known to be production. Refused unconditionally. */
export const KNOWN_PRODUCTION_REFS = Object.freeze(["jlabpfnhbjqgbavpxnyk"]);

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class ProductionDatabaseRefusedError extends Error {
  constructor(reason) {
    super(`Refusing integration tests against production: ${reason}`);
    this.name = "ProductionDatabaseRefusedError";
  }
}

/** Parses a postgres URL into safe, comparable parts. Returns null if unparseable. */
export function describeDatabaseUrl(url) {
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url.replace(/^postgres(ql)?:/, "http:"));
  } catch {
    return null;
  }

  const user = decodeURIComponent(parsed.username);
  const host = parsed.hostname.toLowerCase();
  const database = parsed.pathname.replace(/^\//, "") || "postgres";
  const port = parsed.port || "5432";

  /* Supabase names the project in the pooler username or the direct host. */
  const ref =
    /^postgres\.([a-z0-9]+)$/.exec(user)?.[1] ??
    /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1] ??
    null;

  return { user, host, port, database, ref, isLocal: LOCAL_HOSTS.has(host) };
}

/**
 * @typedef {object} IntegrationTargetInput
 * @property {string | undefined} testDatabaseUrl       TEST_DATABASE_URL
 * @property {string | undefined} [productionDatabaseUrl] the application's DATABASE_URL
 * @property {string | undefined} [allowRemoteHost]     ALLOW_REMOTE_TEST_DATABASE
 * @property {readonly string[]} [knownProductionRefs]
 */

/**
 * The target for this run.
 *
 * @param {IntegrationTargetInput} input
 * @returns {{ mode: "skip" } | { mode: "isolated", databaseUrl: string, label: string }}
 * @throws ProductionDatabaseRefusedError
 */
export function resolveIntegrationTarget({
  testDatabaseUrl,
  productionDatabaseUrl = undefined,
  allowRemoteHost = undefined,
  knownProductionRefs = KNOWN_PRODUCTION_REFS,
}) {
  if (!testDatabaseUrl || testDatabaseUrl.trim() === "") {
    return { mode: "skip" };
  }

  const test = describeDatabaseUrl(testDatabaseUrl);
  if (!test) {
    throw new ProductionDatabaseRefusedError("TEST_DATABASE_URL could not be parsed");
  }

  const production = describeDatabaseUrl(productionDatabaseUrl);

  if (test.ref && knownProductionRefs.includes(test.ref)) {
    throw new ProductionDatabaseRefusedError(
      `project ref ${test.ref} is a known production project`,
    );
  }

  if (production) {
    if (test.ref && production.ref && test.ref === production.ref) {
      throw new ProductionDatabaseRefusedError(
        `TEST_DATABASE_URL targets the same Supabase project (${test.ref}) as DATABASE_URL`,
      );
    }

    if (
      !test.isLocal &&
      test.host === production.host &&
      test.port === production.port &&
      test.database === production.database &&
      test.user === production.user
    ) {
      throw new ProductionDatabaseRefusedError(
        `TEST_DATABASE_URL is the application database (${test.host})`,
      );
    }
  }

  if (!test.isLocal && test.host !== (allowRemoteHost ?? "").toLowerCase()) {
    throw new ProductionDatabaseRefusedError(
      `remote host ${test.host} is not allowed; set ALLOW_REMOTE_TEST_DATABASE=${test.host} ` +
        "to opt in deliberately (never for a production project)",
    );
  }

  return {
    mode: "isolated",
    databaseUrl: testDatabaseUrl,
    label: test.isLocal ? `local ${test.host}:${test.port}` : `remote ${test.host}`,
  };
}
