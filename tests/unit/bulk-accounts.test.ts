import { describe, expect, it } from "vitest";

import { parseDelimited, toRecord } from "@/lib/tabular";
import { parseBulkAccounts } from "@/modules/accounts";

/**
 * Bulk import — the parser and the validation pipeline.
 *
 * Both halves are pure, which is the point: "nothing was written" is asserted
 * here without a database, and the same pipeline will serve a file upload later
 * because an uploaded CSV becomes a string and enters unchanged.
 *
 * The password cases matter most. A Netflix password may legitimately contain a
 * comma or a quote, and a parser that splits it in half produces an account
 * nobody can sign into — silently, because the row still validates.
 */

describe("parseDelimited", () => {
  it("reads comma-separated rows", () => {
    const result = parseDelimited("a@x.com,pw,DZ\nb@x.com,pw2,FR");

    expect(result.delimiter).toBe(",");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.cells).toEqual(["a@x.com", "pw", "DZ"]);
  });

  it("reads tab-separated rows without being told", () => {
    const result = parseDelimited("a@x.com\tpw\tDZ");

    expect(result.delimiter).toBe("\t");
    expect(result.rows[0]?.cells).toEqual(["a@x.com", "pw", "DZ"]);
  });

  it("reads semicolon-separated rows", () => {
    /* What a French or Algerian Excel export produces. */
    const result = parseDelimited("a@x.com;pw;DZ");

    expect(result.delimiter).toBe(";");
    expect(result.rows[0]?.cells).toEqual(["a@x.com", "pw", "DZ"]);
  });

  it("keeps a comma inside a quoted password", () => {
    const result = parseDelimited('a@x.com,"pa,ss",DZ');
    expect(result.rows[0]?.cells).toEqual(["a@x.com", "pa,ss", "DZ"]);
  });

  it("keeps a doubled quote as one literal quote", () => {
    const result = parseDelimited('a@x.com,"pa""ss",DZ');
    expect(result.rows[0]?.cells).toEqual(["a@x.com", 'pa"ss', "DZ"]);
  });

  it("does not let a quoted comma outvote the real delimiter", () => {
    /* One address with a comma must not turn a TSV into a CSV. */
    const result = parseDelimited('a@x.com\t"pa,ss,word"\tDZ');

    expect(result.delimiter).toBe("\t");
    expect(result.rows[0]?.cells).toEqual(["a@x.com", "pa,ss,word", "DZ"]);
  });

  it("handles CRLF from a Windows paste", () => {
    const result = parseDelimited("a@x.com,pw\r\nb@x.com,pw2");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]?.cells[0]).toBe("b@x.com");
  });

  it("skips blank lines but keeps line numbers honest", () => {
    /* The number in an error must match what the operator sees in their editor. */
    const result = parseDelimited("a@x.com,pw\n\n\nb@x.com,pw2");

    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]?.line).toBe(4);
  });

  it("drops a header row when it recognises one", () => {
    const result = parseDelimited("email,password,country\na@x.com,pw,DZ", {
      headers: ["email", "password", "country"],
    });

    expect(result.headerDropped).toBe(true);
    expect(result.rows).toHaveLength(1);
  });

  it("keeps the first row when it is data, not a header", () => {
    const result = parseDelimited("a@x.com,pw,DZ", { headers: ["email", "password"] });

    expect(result.headerDropped).toBe(false);
    expect(result.rows).toHaveLength(1);
  });

  it("strips a BOM from a spreadsheet export", () => {
    const result = parseDelimited("﻿a@x.com,pw", {});
    expect(result.rows[0]?.cells[0]).toBe("a@x.com");
  });
});

describe("toRecord", () => {
  it("treats an omitted trailing column as absent", () => {
    const [row] = parseDelimited("a@x.com,pw").rows;
    const record = toRecord(row!, ["email", "password", "country"]);

    expect(record["country"]).toBeUndefined();
  });

  it("treats an empty cell as absent rather than as an empty value", () => {
    /* A spreadsheet cannot express the difference; a schema default should apply. */
    const [row] = parseDelimited("a@x.com,pw,,90").rows;
    const record = toRecord(row!, ["email", "password", "country", "durationDays"]);

    expect(record["country"]).toBeUndefined();
    expect(record["durationDays"]).toBe("90");
  });
});

describe("parseBulkAccounts", () => {
  it("accepts a well-formed batch", () => {
    const result = parseBulkAccounts(
      ["a@example.com,pw1,DZ,90,3", "b@example.com,pw2,FR,30,5"].join("\n"),
    );

    expect(result.errors).toEqual([]);
    expect(result.valid).toHaveLength(2);
    expect(result.valid[0]?.email).toBe("a@example.com");
    expect(result.valid[0]?.profileSlots).toBe(3);
    expect(result.valid[0]?.durationDays).toBe(90);
  });

  it("defaults the profile count to five when the column is omitted", () => {
    /* Backward compatible with how every account behaved before M13. */
    const result = parseBulkAccounts("a@example.com,pw1,DZ");

    expect(result.errors).toEqual([]);
    expect(result.valid[0]?.profileSlots).toBe(5);
  });

  it("normalises email casing and country code", () => {
    const result = parseBulkAccounts("  A@Example.COM ,pw1,dz");

    expect(result.valid[0]?.email).toBe("a@example.com");
    expect(result.valid[0]?.country).toBe("DZ");
  });

  it("reports the line number of a bad row", () => {
    const result = parseBulkAccounts(
      ["a@example.com,pw1,DZ", "not-an-email,pw2,FR", "c@example.com,pw3,DZ"].join("\n"),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(2);
    expect(result.errors[0]?.fieldErrors["email"]).toBeTruthy();
  });

  it("rejects a row with no password", () => {
    const result = parseBulkAccounts("a@example.com");

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.fieldErrors["password"]).toBeTruthy();
  });

  it("rejects an out-of-range profile count", () => {
    const result = parseBulkAccounts(
      ["a@example.com,pw,DZ,30,6", "b@example.com,pw,DZ,30,0"].join("\n"),
    );

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]?.fieldErrors["profileSlots"]).toBeTruthy();
    expect(result.errors[1]?.fieldErrors["profileSlots"]).toBeTruthy();
  });

  it("rejects an invalid duration", () => {
    const result = parseBulkAccounts(
      ["a@example.com,pw,DZ,0,5", "b@example.com,pw,DZ,-30,5", "c@example.com,pw,DZ,abc,5"].join(
        "\n",
      ),
    );

    expect(result.errors).toHaveLength(3);
    for (const error of result.errors) {
      expect(error.fieldErrors["durationDays"], `line ${error.line}`).toBeTruthy();
    }
  });

  it("catches a duplicate email inside the batch and names both lines", () => {
    const result = parseBulkAccounts(
      ["a@example.com,pw1,DZ", "b@example.com,pw2,DZ", "A@EXAMPLE.com,pw3,DZ"].join("\n"),
    );

    /* Case-insensitively: the schema lowercases before the comparison. */
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(3);
    expect(result.errors[0]?.fieldErrors["email"]).toContain("line 1");
    expect(result.valid).toHaveLength(2);
  });

  it("never echoes a password back in an error", () => {
    /*
     * The whole row is invalid, so the temptation is to report what was read.
     * A rejected row still carries a real Netflix password.
     */
    const result = parseBulkAccounts("not-an-email,SuperSecret123,DZ");
    const serialised = JSON.stringify(result.errors);

    expect(serialised).not.toContain("SuperSecret123");
  });

  it("survives a password containing the delimiter", () => {
    const result = parseBulkAccounts('a@example.com,"pa,ss,word",DZ');

    expect(result.errors).toEqual([]);
    expect(result.valid[0]?.password).toBe("pa,ss,word");
  });

  it("reads a tab-separated paste identically", () => {
    /* Same pipeline, same result — the requirement behind a reusable parser. */
    const csv = parseBulkAccounts("a@example.com,pw1,DZ,90,3");
    const tsv = parseBulkAccounts("a@example.com\tpw1\tDZ\t90\t3");

    expect(tsv.valid).toEqual(csv.valid);
    expect(tsv.delimiter).toBe("\t");
  });

  it("accepts the operator-facing header names", () => {
    /* Their spreadsheet says "duration" and "profiles", not the schema's names. */
    const result = parseBulkAccounts(
      ["email,password,country,duration,profiles", "a@example.com,pw,DZ,90,2"].join("\n"),
    );

    expect(result.headerDropped).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.valid[0]?.profileSlots).toBe(2);
  });

  it("returns nothing at all for empty input", () => {
    expect(parseBulkAccounts("").valid).toEqual([]);
    expect(parseBulkAccounts("   \n\n ").valid).toEqual([]);
  });

  it("keeps the good rows alongside the bad ones", () => {
    /*
     * The partial-success model. An operator importing a hundred accounts must
     * not lose ninety-nine to one typo, so a bad row is reported rather than
     * fatal — and every submitted row lands in exactly one of the two lists.
     */
    const result = parseBulkAccounts(
      ["a@example.com,pw,DZ", "broken-row", "c@example.com,pw,DZ"].join("\n"),
    );

    expect(result.valid).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.valid.length + result.errors.length).toBe(3);
  });

  it("maps an accepted email back to the line it came from", () => {
    /*
     * Needed because a row can still be rejected AFTER parsing — the database
     * refuses an address that already exists — and that must be reported
     * against the line the operator typed, not an index they never saw.
     */
    const result = parseBulkAccounts(["a@example.com,pw,DZ", "", "b@example.com,pw,DZ"].join("\n"));

    expect(result.lineForEmail("a@example.com")).toBe(1);
    expect(result.lineForEmail("b@example.com")).toBe(3);
    /* Case-insensitive, matching how the schema normalises. */
    expect(result.lineForEmail("B@EXAMPLE.COM")).toBe(3);
    expect(result.lineForEmail("never@example.com")).toBeUndefined();
  });
});
