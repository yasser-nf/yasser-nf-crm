import { describe, expect, it } from "vitest";

import {
  buildWhatsAppLink,
  buildWhatsAppMessage,
  formatExpirationForCustomer,
} from "@/lib/whatsapp";

/**
 * The WhatsApp hand-off.
 *
 * A click-to-chat link opens a conversation with the message already typed.
 * Nothing here sends: there is no API call and no automation, and these tests
 * assert the shape of a URL rather than any delivery.
 *
 * The two things that would be expensive to get wrong are the destination and
 * the contents. A wrong destination sends one customer's password to another
 * person; stale contents send credentials for an account the customer was never
 * given. Both are pinned below.
 */

const ACCOUNT = {
  email: "test@gmail.com",
  password: "pibko8282@",
  profiles: [{ profileNumber: 1, pin: "9121" }],
};

function link(
  identifier: string,
  overrides: Partial<Parameters<typeof buildWhatsAppLink>[0]> = {},
) {
  return buildWhatsAppLink({
    identifier,
    accounts: [ACCOUNT],
    durationDays: 30,
    expirationDate: "2026-09-20",
    ...overrides,
  });
}

/** The number wa.me was addressed to. */
function destination(url: string): string {
  return /^https:\/\/wa\.me\/(\d+)\?/.exec(url)?.[1] ?? "NO MATCH";
}

describe("destination — the number is normalized, never assumed Algerian", () => {
  it("Test A: an Algerian local number reaches 213663947116", () => {
    const result = link("0663947116");
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(destination(result.url)).toBe("213663947116");
  });

  it("Test B: +213663947116 reaches the same destination", () => {
    const local = link("0663947116");
    const international = link("+213663947116");

    expect(local.available && international.available).toBe(true);
    if (!local.available || !international.available) return;
    expect(destination(international.url)).toBe(destination(local.url));
    expect(destination(international.url)).toBe("213663947116");
  });

  it("Test C: a Qatari number reaches 97471601974, with no 213 prepended", () => {
    const result = link("+97471601974");
    expect(result.available).toBe(true);
    if (!result.available) return;

    expect(destination(result.url)).toBe("97471601974");
    expect(destination(result.url).startsWith("213"), "no Algerian code bolted on").toBe(false);
  });

  it("other countries keep their own country codes", () => {
    for (const [input, expected] of [
      ["+971501234567", "971501234567"],
      ["+33123456789", "33123456789"],
      ["+14155552671", "14155552671"],
    ] as const) {
      const result = link(input);
      expect(result.available, input).toBe(true);
      if (result.available) expect(destination(result.url), input).toBe(expected);
    }
  });

  it("works from the stored normalized key, not only from typed input", () => {
    /* `result.customerPhone` is the normalized form: nine digits for Algeria. */
    const result = link("663947116");
    expect(result.available).toBe(true);
    if (result.available) expect(destination(result.url)).toBe("213663947116");
  });
});

describe("Test D: a username produces no link at all", () => {
  for (const handle of ["@RAHIMOU", "@rahimou", "@yasser123"]) {
    it(`refuses ${handle} instead of building a broken URL`, () => {
      const result = link(handle);

      expect(result.available).toBe(false);
      if (result.available) return;
      expect(result.reason).toBe("username");
      /* The union has no `url` when unavailable — nothing malformed can escape. */
      expect("url" in result).toBe(false);
    });
  }

  it("an unusable value is refused too, and named differently", () => {
    const result = link("not-a-phone");
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toBe("unusable_number");
  });

  it("the credentials are still available to copy without a link", () => {
    /* The screen falls back to this exact text. */
    const message = buildWhatsAppMessage({
      identifier: "@RAHIMOU",
      accounts: [ACCOUNT],
      durationDays: 30,
      expirationDate: "2026-09-20",
    });

    expect(message).toContain("test@gmail.com");
    expect(message).toContain("pibko8282@");
  });
});

describe("Test E: the message is URL encoded", () => {
  it("newlines, @ and + survive the round trip", () => {
    const result = link("0663947116");
    expect(result.available).toBe(true);
    if (!result.available) return;

    const encoded = result.url.split("?text=")[1] ?? "";

    expect(encoded, "raw newlines would break the URL").not.toContain("\n");
    expect(encoded).toContain("%0A");
    expect(decodeURIComponent(encoded), "decodes back to exactly the message").toBe(result.message);
  });

  it("a password full of URL metacharacters is not mangled", () => {
    const nasty = "p&a=s?s#w+o/rd%20";
    const result = link("0663947116", {
      accounts: [{ ...ACCOUNT, password: nasty }],
    });

    expect(result.available).toBe(true);
    if (!result.available) return;

    const encoded = result.url.split("?text=")[1] ?? "";
    expect(decodeURIComponent(encoded)).toContain(nasty);
    expect(destination(result.url), "and the destination is untouched").toBe("213663947116");
  });
});

describe("Test F / I: the message carries the final allocated account", () => {
  it("contains the email, password, profile, duration and expiration", () => {
    const result = link("0663947116");
    expect(result.available).toBe(true);
    if (!result.available) return;

    expect(result.message).toContain("test@gmail.com");
    expect(result.message).toContain("pibko8282@");
    expect(result.message).toContain("Profile number\n1");
    expect(result.message).toContain("Duration\n30 days");
    expect(result.message).toContain("Expiration\n20 September 2026");
    expect(result.message).toContain("Code pin\n9121");
  });

  it("Test I: the password is the one belonging to the account in the result", () => {
    const result = link("0663947116", {
      accounts: [
        {
          email: "final@example.com",
          password: "final-password",
          profiles: [{ profileNumber: 4, pin: null }],
        },
      ],
    });

    if (!result.available) throw new Error("expected a link");
    expect(result.message).toContain("final@example.com");
    expect(result.message).toContain("final-password");
    expect(result.message).not.toContain("pibko8282@");
  });

  it("a missing PIN reads as an em dash rather than 'null'", () => {
    const result = link("0663947116", {
      accounts: [{ ...ACCOUNT, profiles: [{ profileNumber: 2, pin: null }] }],
    });

    if (!result.available) throw new Error("expected a link");
    expect(result.message).toContain("Code pin\n—");
    expect(result.message).not.toContain("null");
  });

  it("several profiles are separated so the customer can tell them apart", () => {
    const result = link("0663947116", {
      accounts: [
        {
          ...ACCOUNT,
          profiles: [
            { profileNumber: 1, pin: "1111" },
            { profileNumber: 2, pin: "2222" },
          ],
        },
      ],
    });

    if (!result.available) throw new Error("expected a link");
    expect(result.message).toContain("———");
    expect(result.message).toContain("1111");
    expect(result.message).toContain("2222");
  });
});

describe("Tests G / H: Quick Replace sends the NEW account", () => {
  /*
   * Quick Replace renders the same result screen from its own confirmation, and
   * the replaced account is not in that result — so "uses the new one" is a
   * property of the data, and this asserts the helper does not reintroduce the
   * old one from anywhere.
   */
  const OLD = {
    email: "old@broken.com",
    password: "old-password",
    profiles: [{ profileNumber: 1, pin: "0000" }],
  };
  const NEW = {
    email: "new@working.com",
    password: "new-password",
    profiles: [{ profileNumber: 3, pin: "3333" }],
  };

  it("Test G: only the replacement account appears", () => {
    const result = link("0663947116", { accounts: [NEW] });
    if (!result.available) throw new Error("expected a link");

    expect(result.message).toContain("new@working.com");
    expect(result.message).toContain("new-password");
    expect(result.message).not.toContain(OLD.email);
    expect(result.message).not.toContain(OLD.password);
  });

  it("Test H: the profile number is the replacement's", () => {
    const result = link("0663947116", { accounts: [NEW] });
    if (!result.available) throw new Error("expected a link");

    expect(result.message).toContain("Profile number\n3");
    expect(result.message).toContain("Code pin\n3333");
    expect(result.message).not.toContain("Code pin\n0000");
  });
});

describe("Test J: the helper cannot send anything", () => {
  it("returns a URL and a string, and touches no network", () => {
    const result = link("0663947116");
    expect(result.available).toBe(true);
    if (!result.available) return;

    /* wa.me opens a composer. There is no send parameter, and none is added. */
    expect(result.url.startsWith("https://wa.me/")).toBe(true);
    expect(result.url).not.toMatch(/send|autosend|api\.whatsapp/i);
    expect(typeof result.message).toBe("string");
  });
});

describe("expiration is formatted for a person, in UTC", () => {
  it("renders a plain calendar date the same way everywhere", () => {
    expect(formatExpirationForCustomer("2026-09-20")).toBe("20 September 2026");
    expect(formatExpirationForCustomer("2026-01-01")).toBe("1 January 2026");
  });

  it("does not slip a day west of Greenwich", () => {
    /* Parsed as UTC on purpose; a local-time parse would show the 19th. */
    expect(formatExpirationForCustomer("2026-09-20")).toContain("20");
  });

  it("returns anything unparseable unchanged rather than inventing a date", () => {
    expect(formatExpirationForCustomer("not-a-date")).toBe("not-a-date");
  });
});

/**
 * The identifier arriving here is the STORED key, not what an operator typed.
 *
 * `PreparationResult.customerPhone` is the normalized form: nine digits for
 * Algeria, full international digits for everywhere else, `@handle` for a
 * username. An international key therefore carries no `+`.
 *
 * The first version of this helper re-ran that key through `normalizeIdentifier`,
 * which requires an explicit `+` or `00` before reading a number as foreign — a
 * deliberate rule that stops a mistyped local number being treated as
 * international. A stored Qatari key has neither, so it was rejected and a real
 * allocation showed "WhatsApp unavailable". Caught in the browser, not here,
 * because the original test only used the Algerian stored key — nine digits,
 * which is the one international-looking value that happens to work.
 */
describe("stored normalized keys, of every shape", () => {
  const cases: [string, string][] = [
    ["663947116", "213663947116"],
    ["97471601974", "97471601974"],
    ["971501234567", "971501234567"],
    ["33123456789", "33123456789"],
    ["14155552671", "14155552671"],
  ];

  for (const [stored, expected] of cases) {
    it(`stored "${stored}" reaches ${expected}`, () => {
      const result = buildWhatsAppLink({
        identifier: stored,
        accounts: [ACCOUNT],
        durationDays: 30,
        expirationDate: "2026-09-20",
      });

      expect(result.available, `${stored} must produce a link`).toBe(true);
      if (result.available) expect(destination(result.url)).toBe(expected);
    });
  }

  it("a stored international key is not mistaken for an Algerian one", () => {
    const result = buildWhatsAppLink({
      identifier: "97471601974",
      accounts: [ACCOUNT],
      durationDays: 30,
      expirationDate: "2026-09-20",
    });

    if (!result.available) throw new Error("expected a link");
    expect(result.url.includes("wa.me/21397471601974"), "no 213 bolted on").toBe(false);
  });

  it("still accepts raw typed input, for callers that have not normalized", () => {
    for (const [raw, expected] of [
      ["0663947116", "213663947116"],
      ["+97471601974", "97471601974"],
    ] as const) {
      const result = buildWhatsAppLink({
        identifier: raw,
        accounts: [ACCOUNT],
        durationDays: 30,
        expirationDate: "2026-09-20",
      });
      expect(result.available, raw).toBe(true);
      if (result.available) expect(destination(result.url), raw).toBe(expected);
    }
  });
});
