import { expect, test } from "@playwright/test";

/**
 * End-to-end journeys that need no session.
 *
 * Authenticated flows are specified at the bottom and skipped: signing in
 * requires a real password, which cannot live in this repository or in CI
 * without a dedicated test project and a seeded user.
 */

test.describe("Protected routes", () => {
  const protectedPaths = ["/accounts", "/dashboard", "/quick-prepare", "/settings", "/logs"];

  for (const path of protectedPaths) {
    test(`${path} redirects a guest to login and remembers the destination`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login\?next=/);
      expect(page.url()).toContain(encodeURIComponent(path));
    });
  }

  test("root redirects to login for a guest", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe("Login page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/login");
  });

  test("renders the form", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Yasser NF CRM" })).toBeVisible();
    await expect(page.getByLabel(/^email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });

  test("validates empty submission without contacting the server", async ({ page }) => {
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText("Email is required")).toBeVisible();
    await expect(page.getByText("Password is required")).toBeVisible();
  });

  test("rejects a malformed email", async ({ page }) => {
    await page.getByLabel(/^email/i).fill("not-an-email");
    await page.getByLabel(/^password/i).fill("something");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/valid email/i)).toBeVisible();
  });

  test("password toggle reveals and hides", async ({ page }) => {
    const password = page.getByLabel(/^password/i);
    await password.fill("secret");
    await expect(password).toHaveAttribute("type", "password");

    await page.getByRole("button", { name: /show password/i }).click();
    await expect(password).toHaveAttribute("type", "text");

    await page.getByRole("button", { name: /hide password/i }).click();
    await expect(password).toHaveAttribute("type", "password");
  });

  test("rejects wrong credentials without revealing whether the account exists", async ({
    page,
  }) => {
    await page.getByLabel(/^email/i).fill("definitely-not-a-user@example.com");
    await page.getByLabel(/^password/i).fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByRole("alert").filter({ hasText: /incorrect/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(/\/login/);
  });

  test("never exposes a technical error", async ({ page }) => {
    await page.getByLabel(/^email/i).fill("nobody@example.com");
    await page.getByLabel(/^password/i).fill("wrong");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForTimeout(3000);

    const body = (await page.textContent("body")) ?? "";
    for (const leak of ["supabase.co", "postgres", "at Object.", "stack", "AuthApiError"]) {
      expect(body).not.toContain(leak);
    }
  });
});

test.describe("Design system", () => {
  test("renders the dark theme", async ({ page }) => {
    await page.goto("/login");

    const html = page.locator("html");
    await expect(html).toHaveClass(/dark/);
    await expect(html).toHaveAttribute("data-theme", "dark");

    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    /* Dark navy, per 04_UI_GUIDELINES.md. */
    expect(background).toBe("rgb(7, 10, 19)");
  });

  test("is not indexable â€” this is a private internal system", async ({ page }) => {
    await page.goto("/login");
    const robots = page.locator('meta[name="robots"]');
    await expect(robots).toHaveAttribute("content", /noindex/);
  });
});

test.describe("Responsive layout", () => {
  const viewports = [
    { name: "mobile", width: 375, height: 812 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "desktop", width: 1440, height: 900 },
  ];

  for (const viewport of viewports) {
    test(`no horizontal overflow at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/login");

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflows).toBe(false);
    });
  }

  test("every interactive target meets the 44px minimum on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/login");

    const undersized = await page.evaluate(() =>
      [...document.querySelectorAll("button, input, a")]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.height > 0 && box.height < 44;
        })
        .map((el) => el.textContent?.trim() ?? el.tagName),
    );

    expect(undersized).toEqual([]);
  });
});

test.describe("Accessibility", () => {
  test("form controls are reachable and labelled", async ({ page }) => {
    await page.goto("/login");

    await page.keyboard.press("Tab");
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(["INPUT", "BUTTON", "A"]).toContain(focusedTag);

    await expect(page.getByLabel(/^email/i)).toBeVisible();
    await expect(page.getByLabel(/^password/i)).toBeVisible();
  });

  test("validation errors are announced", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
  });

  test("invalid fields are marked for assistive technology", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.locator('[aria-invalid="true"]').first()).toBeVisible();
  });
});

/**
 * Authenticated journeys.
 *
 * Written so the coverage gap is explicit and the specs exist the moment a test
 * project with a seeded user does. Skipped rather than deleted: a missing test
 * is invisible, a skipped one is a documented gap.
 */
test.describe("Authenticated journeys", () => {
  test.skip(true, "Requires a seeded Supabase test user. See KNOWN_LIMITATIONS.md.");

  test("login redirects to the originally requested page", async () => {});
  test("dashboard greets the signed-in user", async () => {});
  test("sidebar shows all ten destinations", async () => {});
  test("sidebar collapse persists across navigation", async () => {});
  test("account creation produces five profiles", async () => {});
  test("profile name and PIN can be edited", async () => {});
  test("archive then restore round trip", async () => {});
  test("quick prepare allocates and copies credentials", async () => {});
  test("replace account reallocates to healthy stock", async () => {});
  test("logout clears the session and re-locks protected routes", async () => {});
});
