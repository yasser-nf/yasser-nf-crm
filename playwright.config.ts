import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration.
 *
 * Only unauthenticated journeys are covered. Signing in requires a real
 * Supabase project and a real password, so authenticated flows — account
 * creation, Quick Prepare, logout — are specified but skipped until a dedicated
 * test project with a seeded user exists. See KNOWN_LIMITATIONS.md.
 *
 * The suite starts its own dev server so a run needs no manual setup.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html"], ["list"]] : "list",

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    /* Dark theme only — 04_UI_GUIDELINES.md forbids a light theme. */
    colorScheme: "dark",
  },

  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000/login",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
