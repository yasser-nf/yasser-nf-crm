import { describe, expect, it } from "vitest";

import {
  buildWhatsappUrl,
  formatPhoneForDisplay,
  isValidAlgerianPhone,
  normalizePhone,
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

describe("normalizePhone — accepted Algerian formats", () => {
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
      const result = normalizePhone(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.normalized).toBe(expected);
      }
    });
  }
});

describe("normalizePhone — every accepted form collapses to one identity", () => {
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
        const r = normalizePhone(f);
        return r.ok ? r.value.normalized : `FAIL:${f}`;
      }),
    );

    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(CANONICAL);
  });
});

describe("normalizePhone — rejections", () => {
  const rejected = [
    ["", "empty"],
    ["   ", "whitespace only"],
    ["123", "too short"],
    ["12345678", "eight digits"],
    ["1234567890", "ten digits"],
    ["06639471160000", "far too long"],
    ["+33612345678", "French number"],
    ["+1234567890", "US number"],
    ["0033612345678", "international non-Algerian"],
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
      expect(normalizePhone(input).ok).toBe(false);
    });
  }

  it("reports a field-level error a form can render", () => {
    const result = normalizePhone("nope");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(result.error.userMessage.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizePhone — derived values", () => {
  it("preserves the original exactly as typed", () => {
    const result = normalizePhone("  +213 663 94 71 16  ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.original).toBe("+213 663 94 71 16");
    }
  });

  it("builds the international form", () => {
    const result = normalizePhone("0663947116");
    if (result.ok) {
      expect(result.value.international).toBe("+213663947116");
    }
  });

  it("builds a wa.me URL with no plus and no separators", () => {
    const result = normalizePhone("+213 663 94 71 16");
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

describe("isValidAlgerianPhone", () => {
  it("is true for a valid number", () => {
    expect(isValidAlgerianPhone("0663947116")).toBe(true);
  });

  it("is false for an invalid number", () => {
    expect(isValidAlgerianPhone("+33612345678")).toBe(false);
  });

  it("agrees with normalizePhone on every case", () => {
    for (const input of ["0663947116", "abc", "", "+213663947116", "123"]) {
      expect(isValidAlgerianPhone(input)).toBe(normalizePhone(input).ok);
    }
  });
});
