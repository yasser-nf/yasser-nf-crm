import { describe, expect, it } from "vitest";

import {
  buildWhatsappUrl,
  formatPhoneForDisplay,
  isValidCustomerIdentifier,
  normalizeIdentifier,
} from "@/lib/phone";

/**
 * Phone Engine tests.
 *
 * 01_MASTER_RULES.md makes the normalised number the customer identity, so a
 * defect here does not merely display a number wrongly — it merges two customers
 * or splits one in two. That is why this file is exhaustive rather than
 * representative.
 */

const CANONICAL = "663947116";

describe("normalizeIdentifier — accepted Algerian formats", () => {
  const accepted: [string, string][] = [
    ["663947116", CANONICAL],
    ["0663947116", CANONICAL],
    ["+213663947116", CANONICAL],
    ["00213663947116", CANONICAL],
    ["213663947116", CANONICAL],
    ["+213 663 94 71 16", CANONICAL],
    ["0663 94 71 16", CANONICAL],
    ["0663-94-71-16", CANONICAL],
    ["0663.94.71.16", CANONICAL],
    ["(0663) 94 71 16", CANONICAL],
    ["  0663947116  ", CANONICAL],
    ["+213-663-947-116", CANONICAL],
    ["00 213 663 947 116", CANONICAL],
    ["0553947116", "553947116"],
    ["0773947116", "773947116"],
    ["+213553947116", "553947116"],
  ];

  for (const [input, expected] of accepted) {
    it(`accepts "${input}"`, () => {
      const result = normalizeIdentifier(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.normalized).toBe(expected);
      }
    });
  }
});

describe("normalizeIdentifier — every accepted form collapses to one identity", () => {
  it("all mobile spellings produce the same key", () => {
    const forms = [
      "663947116",
      "0663947116",
      "+213663947116",
      "00213663947116",
      "+213 663 94 71 16",
      "0663-94-71-16",
    ];

    const keys = new Set(
      forms.map((f) => {
        const r = normalizeIdentifier(f);
        return r.ok ? r.value.normalized : `FAIL:${f}`;
      }),
    );

    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(CANONICAL);
  });
});

describe("normalizeIdentifier — rejections", () => {
  const rejected = [
    ["", "empty"],
    ["   ", "whitespace only"],
    ["123", "too short"],
    ["12345678", "eight digits"],
    ["1234567890", "ten digits"],
    ["06639471160000", "far too long"],
    ["abcdefghi", "letters"],
    ["06639471a6", "embedded letter"],
    ["063947116", "leading zero after trunk strip"],
    ["+213", "country code only"],
    ["00213", "international prefix only"],
    /*
     * Landlines are rejected. The engine requires a 9-digit national number,
     * which covers mobiles (5/6/7 prefixes). Algerian landlines are shorter.
     * Deliberate: the business reaches customers over WhatsApp, so a landline
     * cannot be served anyway. Recorded in KNOWN_LIMITATIONS.md.
     */
    ["021234567", "landline, not supported"],
  ] as const;

  for (const [input, why] of rejected) {
    it(`rejects "${input}" (${why})`, () => {
      expect(normalizeIdentifier(input).ok).toBe(false);
    });
  }

  it("reports a field-level error a form can render", () => {
    const result = normalizeIdentifier("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.userMessage.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeIdentifier — derived values", () => {
  it("preserves the original exactly as typed", () => {
    const result = normalizeIdentifier("  +213 663 94 71 16  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.original).toBe("+213 663 94 71 16");
    }
  });

  it("builds the international form", () => {
    const result = normalizeIdentifier("0663947116");
    if (result.ok) {
      expect(result.value.international).toBe("+213663947116");
    }
  });

  it("builds a wa.me URL with no plus and no separators", () => {
    const result = normalizeIdentifier("+213 663 94 71 16");
    if (result.ok) {
      expect(result.value.whatsappUrl).toBe("https://wa.me/213663947116");
      expect(result.value.whatsappUrl).not.toContain("+");
      expect(result.value.whatsappUrl).not.toContain(" ");
    }
  });
});

describe("buildWhatsappUrl", () => {
  it("prefixes the country code", () => {
    expect(buildWhatsappUrl("663947116")).toBe("https://wa.me/213663947116");
  });

  it("never emits a plus sign", () => {
    expect(buildWhatsappUrl("553947116")).not.toContain("+");
  });
});

describe("formatPhoneForDisplay", () => {
  it("formats as it is written locally", () => {
    expect(formatPhoneForDisplay("663947116")).toBe("0663 94 71 16");
  });

  it("returns unexpected input unchanged rather than corrupting it", () => {
    expect(formatPhoneForDisplay("123")).toBe("123");
  });
});

describe("isValidCustomerIdentifier", () => {
  it("is true for a valid number", () => {
    expect(isValidCustomerIdentifier("0663947116")).toBe(true);
  });

  it("is false for an invalid number", () => {
    expect(isValidCustomerIdentifier("not-a-number")).toBe(false);
  });

  it("agrees with normalizeIdentifier on every case", () => {
    for (const input of ["0663947116", "abc", "", "+213663947116", "123"]) {
      expect(isValidCustomerIdentifier(input)).toBe(normalizeIdentifier(input).ok);
    }
  });
});

/**
 * Customer identifier: usernames and international numbers.
 *
 * The field labelled "Customer phone" is really a customer identifier. It used
 * to accept Algerian numbers only, which left two real customers unreachable:
 * the one abroad, and the one known only by a messaging handle.
 *
 * Algeria keeps its nine-digit key. That is the load-bearing assertion in this
 * file — every existing customer row is keyed on it.
 */

describe("normalizeIdentifier — usernames", () => {
  const accepted: [string, string][] = [
    ["@RAHIMOU", "@rahimou"],
    ["@yasser123", "@yasser123"],
    ["@customer123", "@customer123"],
    ["@yasser", "@yasser"],
    ["@a_b.c", "@a_b.c"],
    ["  @RAHIMOU  ", "@rahimou"],
  ];

  for (const [input, key] of accepted) {
    it(`accepts "${input}"`, () => {
      const result = normalizeIdentifier(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kind).toBe("username");
        expect(result.value.normalized).toBe(key);
      }
    });
  }

  it("preserves the spelling the operator typed", () => {
    const result = normalizeIdentifier("@RAHIMOU");
    if (result.ok) {
      expect(result.value.original).toBe("@RAHIMOU");
      expect(result.value.normalized).toBe("@rahimou");
    }
  });

  it("treats case variants as one customer", () => {
    const keys = ["@RAHIMOU", "@rahimou", "@RaHiMoU"].map((f) => {
      const r = normalizeIdentifier(f);
      return r.ok ? r.value.normalized : `FAIL:${f}`;
    });
    expect(new Set(keys).size).toBe(1);
  });

  it("has no WhatsApp link, because wa.me addresses a number", () => {
    const result = normalizeIdentifier("@rahimou");
    if (result.ok) {
      expect(result.value.whatsappUrl).toBe("");
    }
  });

  const rejected = ["@", "@no spaces", "@bad!", "@@double", `@${"x".repeat(31)}`];

  for (const input of rejected) {
    it(`rejects "${input}"`, () => {
      expect(normalizeIdentifier(input).ok).toBe(false);
    });
  }
});

describe("normalizeIdentifier — international numbers", () => {
  const accepted: [string, string][] = [
    ["+97471601974", "97471601974"],
    ["+971501234567", "971501234567"],
    ["+33123456789", "33123456789"],
    ["+14155552671", "14155552671"],
    ["+33 1 23 45 67 89", "33123456789"],
    ["0033123456789", "33123456789"],
    ["+1 (415) 555-2671", "14155552671"],
  ];

  for (const [input, key] of accepted) {
    it(`accepts "${input}"`, () => {
      const result = normalizeIdentifier(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.kind).toBe("phone");
        expect(result.value.normalized).toBe(key);
      }
    });
  }

  it("keeps the country code in the key, since there is no national context", () => {
    const result = normalizeIdentifier("+97471601974");
    if (result.ok) {
      expect(result.value.international).toBe("+97471601974");
      expect(result.value.whatsappUrl).toBe("https://wa.me/97471601974");
    }
  });

  it("still rejects a number that is too short or too long to be dialled", () => {
    expect(normalizeIdentifier("+1234567").ok).toBe(false);
    expect(normalizeIdentifier("+1234567890123456").ok).toBe(false);
  });

  it("requires an explicit + or 00, so a mistyped local number is not read as foreign", () => {
    expect(normalizeIdentifier("1234567890").ok).toBe(false);
  });
});

describe("normalizeIdentifier — Algerian identity is unchanged", () => {
  it("still reduces every Algerian form to nine national digits", () => {
    for (const form of ["0663947116", "+213663947116", "00213663947116", "663947116"]) {
      const r = normalizeIdentifier(form);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.normalized).toBe(CANONICAL);
    }
  });

  it("does not re-key Algeria to its international form", () => {
    const r = normalizeIdentifier("+213663947116");
    if (r.ok) {
      expect(r.value.normalized).toBe("663947116");
      expect(r.value.normalized).not.toBe("213663947116");
    }
  });

  it("keeps a username and a number in separate namespaces", () => {
    const a = normalizeIdentifier("0663947116");
    const b = normalizeIdentifier("@663947116");
    if (a.ok && b.ok) expect(a.value.normalized).not.toBe(b.value.normalized);
  });
});

describe("every stored key satisfies the database constraint", () => {
  /* 0012_customer_identifier.sql */
  const CONSTRAINT = /^([0-9]{6,20}|@[a-z0-9_.]{1,30})$/;

  const inputs = [
    "0663947116",
    "+213663947116",
    "663947116",
    "+97471601974",
    "+971501234567",
    "+33123456789",
    "+14155552671",
    "@RAHIMOU",
    "@yasser123",
  ];

  for (const input of inputs) {
    it(`"${input}" produces a storable key`, () => {
      const r = normalizeIdentifier(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(CONSTRAINT.test(r.value.normalized)).toBe(true);
    });
  }
});

describe("formatPhoneForDisplay — all three shapes", () => {
  it("groups an Algerian number the way it is written locally", () => {
    expect(formatPhoneForDisplay("663947116")).toBe("0663 94 71 16");
  });

  it("shows an international number with its plus", () => {
    expect(formatPhoneForDisplay("97471601974")).toBe("+97471601974");
  });

  it("shows a username as typed", () => {
    expect(formatPhoneForDisplay("@rahimou")).toBe("@rahimou");
  });
});
