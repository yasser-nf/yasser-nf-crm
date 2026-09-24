import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import { accountMatchesStatusSql } from "@/lib/drizzle/predicates";
import { ACCOUNT_STATUS_OPTIONS } from "@/modules/accounts/components/status-badge";
import { accountBadgeStyle } from "@/modules/accounts/components/status-badge";
import { accountEffectiveStatus } from "@/modules/accounts/services/account-validity";
import type { AccountRow } from "@/lib/drizzle/schema";
import { ACCOUNT_STATUSES, parseAccountFilter } from "@/modules/accounts/services/account-filters";
import { BLOCKING_STATUSES } from "@/modules/problems";

/**
 * The badge the application would show: `accountEffectiveStatus` (the one
 * derivation, M03) rendered by `accountBadgeStyle`. An open account with no
 * validity boundary, so only status and problems are in play.
 */
function badgeOf(
  status: AccountRow["status"],
  hasActiveProblem: boolean,
  activeProblemTypes: readonly string[] = [],
) {
  const types = hasActiveProblem
    ? activeProblemTypes.length > 0
      ? activeProblemTypes
      : ["other"]
    : [];

  return accountBadgeStyle(
    accountEffectiveStatus(
      { status, validUntil: null, deletedAt: null },
      types,
      new Date("2026-09-24T12:00:00Z"),
    ),
  );
}

/**
 * Filtering the accounts list by status.
 *
 * The bug: `baleinier-pulsar.6b@icloud.com` showed a Problem badge while the
 * Payment Problem filter returned "No accounts yet". Its `accounts.status` is
 * `healthy` — ADR-010 Decision 4 keeps problems out of that column — and the
 * badge derives Problem from an open `payment_problem` issue. The filter asked
 * the column; the screen answered from the issue. Two definitions of one word.
 *
 * `accountMatchesStatusSql` is now the single definition, and these render it to
 * real SQL so the shape can be asserted without a database.
 */

const dialect = new PgDialect();
const render = (status: Parameters<typeof accountMatchesStatusSql>[0]) => {
  const query = dialect.sqlToQuery(accountMatchesStatusSql(status));

  return { sql: query.sql, params: query.params };
};

describe("a fault status matches the badge, not just the column", () => {
  it("finds an account whose status column says payment_problem", () => {
    const { sql, params } = render("payment_problem");

    expect(sql).toContain('"accounts"."status" =');
    expect(params).toContain("payment_problem");
  });

  it("also finds one carrying an OPEN payment problem while stored healthy", () => {
    /*
     * The reported bug, in one assertion. Without the `exists` clause the query
     * can only ever return rows whose column already says payment_problem, and
     * nothing writes that column.
     */
    const { sql } = render("payment_problem");

    expect(sql).toContain("exists");
    expect(sql).toContain('"issues"');
    expect(sql).toContain('"issue_type"');
  });

  it("requires the open problem to be of the SAME type", () => {
    /*
     * An account whose only open problem is a wrong password must not surface
     * under Payment Problem. The type is bound as a parameter, so each fault
     * filter asks about its own fault.
     */
    for (const status of [
      "payment_problem",
      "incorrect_password",
      "invalid_email",
      "something_went_wrong",
    ] as const) {
      const { params } = render(status);

      expect(params.filter((p) => p === status)).toHaveLength(2);
    }
  });

  it("only counts problems in a blocking status", () => {
    /* A resolved payment problem must not keep an account in the filter. */
    const { sql } = render("payment_problem");

    for (const blocking of BLOCKING_STATUSES) {
      expect(sql).toContain(blocking);
    }

    expect(sql).not.toContain("resolved");
    expect(sql).not.toContain("cancelled");
  });
});

describe("healthy is the mirror image", () => {
  it("excludes an account carrying a blocking problem", () => {
    /*
     * The same inconsistency from the other side. An account with an open
     * problem shows Problem, not Healthy, so Healthy must not return it.
     */
    const { sql } = render("healthy");

    expect(sql).toContain("not exists");
    expect(sql).toContain('"issues"');
  });

  it("does not filter by issue type, because any open problem hides Healthy", () => {
    const { sql } = render("healthy");

    expect(sql).not.toContain('"issue_type"');
  });
});

describe("lifecycle statuses are left alone", () => {
  it.each(["archived", "deleted"] as const)("%s matches the column exactly", (status) => {
    const { sql, params } = render(status);

    expect(sql).toContain('"accounts"."status" =');
    expect(sql).not.toContain("exists");
    expect(params).toEqual([status]);
  });
});

describe("one definition of Problem", () => {
  it("uses the same blocking statuses the badge derives from", () => {
    /*
     * The predicate writes the list out because ADR-003 forbids a repository
     * importing the problems module. This is the test that comment promises:
     * it is what stops the copy drifting from the original.
     */
    const { sql } = render("payment_problem");

    for (const status of BLOCKING_STATUSES) {
      expect(sql).toContain(`'${status}'`);
    }
  });

  it("treats exactly the four fault statuses as derivable", () => {
    /*
     * These four exist in both `account_status` and `issue_type`. Healthy,
     * archived and deleted have no matching issue type and nothing derives them.
     */
    const derivable = ACCOUNT_STATUSES.filter((s) => render(s).sql.includes('"issue_type"'));

    expect(derivable).toEqual([
      "payment_problem",
      "incorrect_password",
      "invalid_email",
      "something_went_wrong",
    ]);
  });

  it("agrees with the badge about which account reads Problem", () => {
    /* Stored healthy + an open problem is the case the filter used to miss. */
    expect(badgeOf("healthy", true).label).toBe("Problem");
    expect(badgeOf("healthy", false).label).toBe("Healthy");
    expect(badgeOf("payment_problem", false).label).toBe("Payment Problem");
  });
});

describe("the query string and the dropdown agree", () => {
  it("parses every value the dropdown can produce", () => {
    /*
     * A shared link and a click on the Select must select the same rows. The
     * dropdown's values and the parser's whitelist are the two halves of that.
     */
    for (const option of ACCOUNT_STATUS_OPTIONS) {
      expect(parseAccountFilter({ status: option.value }).status).toBe(option.value);
    }
  });

  it("offers exactly the statuses the parser accepts", () => {
    expect(ACCOUNT_STATUS_OPTIONS.map((o) => o.value).toSorted()).toEqual(
      [...ACCOUNT_STATUSES].toSorted(),
    );
  });

  it("keeps the Payment Problem label", () => {
    const option = ACCOUNT_STATUS_OPTIONS.find((o) => o.value === "payment_problem");

    expect(option?.label).toBe("Payment Problem");
  });

  it("treats an unknown status in the URL as no filter", () => {
    expect(parseAccountFilter({ status: "problem" }).status).toBeUndefined();
    expect(parseAccountFilter({ status: "'; drop table accounts--" }).status).toBeUndefined();
  });

  it("applies no status condition when All statuses is selected", () => {
    expect(parseAccountFilter({}).status).toBeUndefined();
  });
});
