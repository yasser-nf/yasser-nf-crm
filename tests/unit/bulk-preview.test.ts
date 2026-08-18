import { describe, expect, it } from "vitest";

import { previewBulkAccounts } from "@/modules/accounts";

/**
 * The bulk import preview.
 *
 * A projection over `parseBulkAccounts`, so these tests do NOT re-check parsing
 * rules — `bulk-accounts.test.ts` already owns delimiter detection, quoting,
 * header aliases and per-field validation. What is asserted here is the part the
 * projection adds and could get wrong on its own:
 *
 *   - every submitted line appears exactly once, in line order
 *   - no password reaches the preview, ever
 *   - the counts an operator reads match the rows they are shown
 */

const SECRET = "SuperSecret123!";

describe("preview shape", () => {
  it("returns one row per submitted line, in line order", () => {
    const preview = previewBulkAccounts(
      ["c@example.com,pw,DZ", "not-an-email,pw,FR", "a@example.com,pw,DZ"].join("\n"),
    );

    expect(preview.submitted).toBe(3);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows.map((row) => row.line)).toEqual([1, 2, 3]);
  });

  it("keeps the counts consistent with the rows", () => {
    const preview = previewBulkAccounts(
      ["a@example.com,pw,DZ", "broken", "b@example.com,pw,DZ"].join("\n"),
    );

    expect(preview.validCount).toBe(preview.rows.filter((row) => row.valid).length);
    expect(preview.invalidCount).toBe(preview.rows.filter((row) => !row.valid).length);
    expect(preview.validCount + preview.invalidCount).toBe(preview.submitted);
  });

  it("reports an empty paste as nothing rather than as an error", () => {
    const preview = previewBulkAccounts("");

    expect(preview.rows).toEqual([]);
    expect(preview.submitted).toBe(0);
    expect(preview.validCount).toBe(0);
  });

  it("preserves the real line number when blank lines are skipped", () => {
    const preview = previewBulkAccounts(
      ["a@example.com,pw", "", "", "b@example.com,pw"].join("\n"),
    );

    expect(preview.rows.map((row) => row.line)).toEqual([1, 4]);
  });
});

describe("password redaction", () => {
  it("never includes a password on a VALID row", () => {
    const preview = previewBulkAccounts(`a@example.com,${SECRET},DZ`);
    const serialised = JSON.stringify(preview);

    expect(preview.validCount).toBe(1);
    expect(serialised).not.toContain(SECRET);
    expect(preview.rows[0]).not.toHaveProperty("password");
  });

  it("never includes a password on an INVALID row", () => {
    /* The row failed, so the temptation is to echo what was read. */
    const preview = previewBulkAccounts(`not-an-email,${SECRET},DZ`);
    const serialised = JSON.stringify(preview);

    expect(preview.invalidCount).toBe(1);
    expect(serialised).not.toContain(SECRET);
  });

  it("never leaks a password that contains the delimiter", () => {
    const preview = previewBulkAccounts(`a@example.com,"pa,ss,${SECRET}",DZ`);
    expect(JSON.stringify(preview)).not.toContain(SECRET);
  });

  it("reports only WHETHER a password is present", () => {
    const withPassword = previewBulkAccounts("a@example.com,pw,DZ");
    expect(withPassword.rows[0]?.hasPassword).toBe(true);

    /* A row with no password fails validation, and says so without the field. */
    const without = previewBulkAccounts("a@example.com");
    expect(without.rows[0]?.valid).toBe(false);
    expect(without.rows[0]?.fieldErrors["password"]).toBeTruthy();
  });
});

describe("what the operator is shown", () => {
  it("surfaces the detected delimiter for a CSV paste", () => {
    expect(previewBulkAccounts("a@example.com,pw,DZ").delimiter).toBe(",");
  });

  it("surfaces the detected delimiter for a TSV paste", () => {
    expect(previewBulkAccounts("a@example.com\tpw\tDZ").delimiter).toBe("\t");
  });

  it("reads a TSV paste into the same rows as the CSV equivalent", () => {
    /* Same pipeline; the preview must not reinterpret either. */
    const csv = previewBulkAccounts("a@example.com,pw,DZ,90,3");
    const tsv = previewBulkAccounts("a@example.com\tpw\tDZ\t90\t3");

    expect(tsv.rows[0]?.email).toBe(csv.rows[0]?.email);
    expect(tsv.rows[0]?.durationDays).toBe(90);
    expect(tsv.rows[0]?.profileSlots).toBe(3);
  });

  it("reports a skipped header row", () => {
    const preview = previewBulkAccounts(
      ["email,password,country", "a@example.com,pw,DZ"].join("\n"),
    );

    expect(preview.headerDropped).toBe(true);
    expect(preview.submitted).toBe(1);
  });

  it("shows open-ended validity as an absent duration rather than a zero", () => {
    const preview = previewBulkAccounts("a@example.com,pw,DZ");

    expect(preview.rows[0]?.durationDays).toBeNull();
    expect(preview.rows[0]?.profileSlots).toBe(5);
  });

  it("carries the field-level reason for a rejected row", () => {
    const preview = previewBulkAccounts("a@example.com,pw,DZ,30,9");

    expect(preview.rows[0]?.valid).toBe(false);
    expect(preview.rows[0]?.fieldErrors["profileSlots"]).toBeTruthy();
  });

  it("flags an in-batch duplicate against the first line that used it", () => {
    const preview = previewBulkAccounts(["a@example.com,pw,DZ", "A@EXAMPLE.com,pw2,FR"].join("\n"));

    const duplicate = preview.rows.find((row) => !row.valid);

    expect(duplicate?.line).toBe(2);
    expect(duplicate?.fieldErrors["email"]).toContain("line 1");
  });
});
