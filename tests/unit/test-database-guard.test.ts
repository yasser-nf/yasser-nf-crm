import { describe, expect, it } from "vitest";

import {
  PLACEHOLDER_DATABASE_URL,
  ProductionDatabaseRefusedError,
  describeDatabaseUrl,
  resolveIntegrationTarget,
} from "../support/database-target.mjs";

/**
 * The integration suite must never write to production.
 *
 * Until M01.5 it did: tests/setup/env.ts loaded `.env.local`, whose
 * DATABASE_URL is production, and integration tests created and deleted real
 * rows there. resolveIntegrationTarget is now the only gate, and these tests
 * are what make the refusal a guarantee rather than an intention.
 *
 * The URLs below are shaped like the real ones — pooler host, `postgres.<ref>`
 * user — with fake passwords. A project ref is an identifier, not a secret: it
 * is in the public Supabase URL every browser already receives.
 */

const PROD_REF = "jlabpfnhbjqgbavpxnyk";
const PRODUCTION = `postgresql://postgres.${PROD_REF}:fake-secret@aws-1-eu-west-1.pooler.supabase.com:5432/postgres`;
const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54321/postgres?sslmode=disable";

const refuse =
  (testDatabaseUrl: string, extra: Record<string, unknown> = {}) =>
  () =>
    resolveIntegrationTarget({ testDatabaseUrl, productionDatabaseUrl: PRODUCTION, ...extra });

describe("the default run cannot reach a database at all", () => {
  it("skips integration tests when no test database is named", () => {
    expect(
      resolveIntegrationTarget({ testDatabaseUrl: undefined, productionDatabaseUrl: PRODUCTION }),
    ).toEqual({
      mode: "skip",
    });
    expect(
      resolveIntegrationTarget({ testDatabaseUrl: "  ", productionDatabaseUrl: PRODUCTION }),
    ).toEqual({
      mode: "skip",
    });
  });

  it("LIVE: this very run has DATABASE_URL pointed away from production", () => {
    /*
     * Not a model of the setup file — the setup file's actual effect on the
     * process running this test. `npm test` sets no TEST_DATABASE_URL, so the
     * integration files see the placeholder and skip instead of connecting.
     */
    if (!process.env["TEST_DATABASE_URL"]) {
      expect(process.env["DATABASE_URL"]).toBe(PLACEHOLDER_DATABASE_URL);
    } else {
      expect(describeDatabaseUrl(process.env["DATABASE_URL"])?.ref).not.toBe(PROD_REF);
    }
  });
});

describe("production is refused, however it is written", () => {
  it("refuses the application's own DATABASE_URL", () => {
    expect(refuse(PRODUCTION)).toThrow(ProductionDatabaseRefusedError);
    expect(refuse(PRODUCTION)).toThrow(/^Refusing integration tests against production/);
  });

  it("refuses the same project through the DIRECT host instead of the pooler", () => {
    expect(refuse(`postgresql://postgres:fake@db.${PROD_REF}.supabase.co:5432/postgres`)).toThrow(
      ProductionDatabaseRefusedError,
    );
  });

  it("refuses the same project on the transaction-mode port", () => {
    expect(
      refuse(
        `postgresql://postgres.${PROD_REF}:fake@aws-1-eu-west-1.pooler.supabase.com:6543/postgres`,
      ),
    ).toThrow(ProductionDatabaseRefusedError);
  });

  it("refuses a known production ref even when DATABASE_URL is unset", () => {
    expect(() =>
      resolveIntegrationTarget({
        testDatabaseUrl: `postgresql://postgres.${PROD_REF}:x@anywhere.example.com:5432/postgres`,
        productionDatabaseUrl: undefined,
        allowRemoteHost: "anywhere.example.com",
      }),
    ).toThrow(ProductionDatabaseRefusedError);
  });

  it("cannot be talked into production by the remote opt-in", () => {
    /* ALLOW_REMOTE_TEST_DATABASE opens remote hosts, never the production project. */
    expect(refuse(PRODUCTION, { allowRemoteHost: "aws-1-eu-west-1.pooler.supabase.com" })).toThrow(
      ProductionDatabaseRefusedError,
    );
  });

  it("refuses a URL it cannot parse rather than guessing", () => {
    expect(refuse("not a url at all")).toThrow(ProductionDatabaseRefusedError);
  });

  it("never puts a password in the refusal message", () => {
    try {
      refuse(PRODUCTION)();
    } catch (error) {
      expect(String(error)).not.toContain("fake-secret");
      return;
    }
    throw new Error("expected a refusal");
  });
});

describe("what IS allowed", () => {
  it("allows a local database — the in-process PGlite server", () => {
    expect(refuse(LOCAL)()).toEqual({
      mode: "isolated",
      databaseUrl: LOCAL,
      label: "local 127.0.0.1:54321",
    });
  });

  it("refuses a remote non-production database by default", () => {
    expect(
      refuse(
        "postgresql://postgres.stagingref123:x@aws-1-eu-west-1.pooler.supabase.com:5432/postgres",
      ),
    ).toThrow(/ALLOW_REMOTE_TEST_DATABASE/);
  });

  it("allows a remote non-production database only when its host is named", () => {
    const staging = "postgresql://postgres:x@staging-db.example.com:5432/postgres";

    expect(refuse(staging, { allowRemoteHost: "staging-db.example.com" })()).toMatchObject({
      mode: "isolated",
      label: "remote staging-db.example.com",
    });
  });
});

describe("recognising a Supabase project", () => {
  it("reads the ref from a pooler username", () => {
    expect(describeDatabaseUrl(PRODUCTION)?.ref).toBe(PROD_REF);
  });

  it("reads the ref from a direct host", () => {
    expect(
      describeDatabaseUrl(`postgresql://postgres:x@db.${PROD_REF}.supabase.co:5432/postgres`)?.ref,
    ).toBe(PROD_REF);
  });

  it("treats localhost as local and has no ref", () => {
    expect(describeDatabaseUrl(LOCAL)).toMatchObject({ isLocal: true, ref: null });
  });
});
