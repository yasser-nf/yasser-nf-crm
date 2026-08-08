import { describe, expect, it } from "vitest";

import {
  formatAccountCredentials,
  formatCustomer,
  formatPassword,
  formatPreparation,
} from "@/lib/clipboard";
import {
  ActionError,
  ConflictError,
  NotFoundError,
  UnexpectedError,
  ValidationError,
  isAppError,
  toAppError,
} from "@/lib/errors";
import { fail, isFailure, isSuccess, mapResult, ok, unwrap, unwrapOr } from "@/utils/result";

/**
 * Clipboard, Result and error-hierarchy tests.
 *
 * The clipboard format is verified byte for byte against the M04 brief, because
 * a worker pastes it straight into a customer's chat — a stray character is
 * visible to the customer, not to us.
 */

describe("formatAccountCredentials", () => {
  it("matches the brief exactly", () => {
    const text = formatAccountCredentials({
      email: "example@email.com",
      password: "password",
      profiles: [{ profileNumber: 2, pin: "9121", profileName: null }],
    });

    expect(text).toBe("example@email.com\npassword\n\nProfile : 2\nPIN : 9121");
  });

  it("puts email and password on the first two lines", () => {
    const lines = formatAccountCredentials({
      email: "a@b.com",
      password: "secret",
      profiles: [],
    }).split("\n");

    expect(lines[0]).toBe("a@b.com");
    expect(lines[1]).toBe("secret");
  });

  it("renders one block per profile", () => {
    const text = formatAccountCredentials({
      email: "a@b.com",
      password: "p",
      profiles: [
        { profileNumber: 1, pin: "1111", profileName: null },
        { profileNumber: 3, pin: "3333", profileName: null },
      ],
    });

    expect(text).toContain("Profile : 1");
    expect(text).toContain("Profile : 3");
    expect(text.match(/Profile : /g)).toHaveLength(2);
  });

  it("shows a dash when no PIN is set rather than the word null", () => {
    const text = formatAccountCredentials({
      email: "a@b.com",
      password: "p",
      profiles: [{ profileNumber: 1, pin: null, profileName: null }],
    });

    expect(text).toContain("PIN : —");
    expect(text).not.toContain("null");
  });
});

describe("formatPreparation", () => {
  const one = {
    email: "a@b.com",
    password: "p1",
    profiles: [{ profileNumber: 1, pin: "1111", profileName: null }],
  };
  const two = {
    email: "c@d.com",
    password: "p2",
    profiles: [{ profileNumber: 2, pin: "2222", profileName: null }],
  };

  it("adds no separator for a single account", () => {
    expect(formatPreparation([one])).not.toContain("———");
  });

  it("separates multiple accounts", () => {
    const text = formatPreparation([one, two]);
    expect(text).toContain("———");
    expect(text).toContain("a@b.com");
    expect(text).toContain("c@d.com");
  });

  it("returns an empty string for no accounts", () => {
    expect(formatPreparation([])).toBe("");
  });
});

describe("formatPassword / formatCustomer", () => {
  it("returns the password unchanged", () => {
    expect(formatPassword("p@ss word")).toBe("p@ss word");
  });

  it("puts the phone and link on separate lines", () => {
    expect(
      formatCustomer({ displayPhone: "0663 94 71 16", whatsappUrl: "https://wa.me/213663947116" }),
    ).toBe("0663 94 71 16\nhttps://wa.me/213663947116");
  });
});

describe("Result helpers", () => {
  it("ok carries a value", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(isSuccess(result)).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it("ok supports the void form", () => {
    expect(ok().ok).toBe(true);
  });

  it("fail carries the error", () => {
    const result = fail(new NotFoundError("missing"));
    expect(isFailure(result)).toBe(true);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("unwrap returns the value on success", () => {
    expect(unwrap(ok("value"))).toBe("value");
  });

  it("unwrap throws the AppError on failure", () => {
    expect(() => unwrap(fail(new ConflictError("dupe")))).toThrowError(ConflictError);
  });

  it("unwrapOr falls back on failure", () => {
    expect(unwrapOr(fail(new NotFoundError("x")), "fallback")).toBe("fallback");
  });

  it("unwrapOr returns the value on success", () => {
    expect(unwrapOr(ok("real"), "fallback")).toBe("real");
  });

  it("mapResult transforms a success", () => {
    const mapped = mapResult(ok(2), (n) => n * 5);
    expect(mapped.ok && mapped.value).toBe(10);
  });

  it("mapResult leaves a failure untouched", () => {
    const mapped = mapResult(fail(new NotFoundError("x")), (n: number) => n * 5);
    expect(mapped.ok).toBe(false);
  });
});

describe("error hierarchy", () => {
  it("every error carries a user-facing message", () => {
    const errors = [
      new ValidationError("v"),
      new NotFoundError("n"),
      new ConflictError("c"),
      new UnexpectedError("u"),
    ];

    for (const error of errors) {
      expect(error.userMessage.length).toBeGreaterThan(0);
    }
  });

  it("never exposes the technical message as the user message", () => {
    const error = new NotFoundError("relation profiles_pkey does not exist");
    expect(error.userMessage).not.toContain("profiles_pkey");
  });

  it("honours an explicit user message", () => {
    expect(new ConflictError("tech", { userMessage: "That already exists." }).userMessage).toBe(
      "That already exists.",
    );
  });

  it("marks expected conditions as operational", () => {
    expect(new NotFoundError("x").isOperational).toBe(true);
    expect(new UnexpectedError("x").isOperational).toBe(false);
  });

  it("omits the stack from the log shape", () => {
    const logged = new ConflictError("x", { context: { operation: "test" } }).toLogObject();
    expect(logged).not.toHaveProperty("stack");
    expect(logged["code"]).toBe("CONFLICT");
  });

  it("carries field errors for form display", () => {
    const error = new ValidationError("bad", { fieldErrors: { email: "Required" } });
    expect(error.fieldErrors?.["email"]).toBe("Required");
  });

  it("isAppError narrows correctly", () => {
    expect(isAppError(new NotFoundError("x"))).toBe(true);
    expect(isAppError(new Error("plain"))).toBe(false);
    expect(isAppError("string")).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it("toAppError converts anything thrown", () => {
    expect(toAppError(new Error("boom")).code).toBe("UNEXPECTED_ERROR");
    expect(toAppError("string throw").code).toBe("UNEXPECTED_ERROR");
    expect(toAppError(new NotFoundError("keep")).code).toBe("NOT_FOUND");
  });

  it("ActionError restores identity across the server boundary", () => {
    const error = new ActionError("Friendly text", "CONFLICT", { email: "Taken" });
    expect(isAppError(error)).toBe(true);
    expect(error.userMessage).toBe("Friendly text");
    expect(error.fieldErrors?.["email"]).toBe("Taken");
  });
});
