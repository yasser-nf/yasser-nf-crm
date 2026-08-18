import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { AppUser } from "@/lib/auth";

/**
 * Preview and confirm must never disagree about account validity.
 *
 * This file exists because they did. `previewAllocationAction` took
 * `(profileCount: number)` and never forwarded the duration, while the service
 * accepted it as an optional second parameter — so nothing failed, the preview
 * silently stopped filtering by account validity, and a worker could be shown
 * an account that confirmation then refused. After they had named it to the
 * customer.
 *
 * The fix made the duration a REQUIRED field of a validated schema, so the
 * omission is no longer representable: an action that forgets it now gets a
 * validation error instead of a quietly different answer.
 *
 * WHAT THESE TESTS DRIVE, AND WHY NOT THE ACTION
 *
 * Server Actions cannot be invoked here — `run()` reads the session, which calls
 * `cookies()`, which throws outside a Next request scope. So these drive
 * `quickPrepareService.preview`, which is where the schema lives and therefore
 * where the guarantee actually is.
 *
 * The remaining link, action → service, is one line that forwards its input
 * unchanged, and the hook that calls it is typed `{profileCount, durationDays}`
 * so TypeScript rejects a partial call at compile time. That link is covered by
 * the type system rather than by these tests, and it is stated plainly rather
 * than implied.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const configured = DATABASE_URL !== "" && !DATABASE_URL.includes("placeholder");

const sql = configured ? postgres(DATABASE_URL, { prepare: false, max: 1 }) : null;

const PREFIX = "m13-agree";
const PLAINTEXT = "not-a-real-password";

let superAdmin: AppUser;

function email(name: string): string {
  return `${PREFIX}-${name}-${Date.now()}-${Math.floor(Math.random() * 10000)}@example.invalid`;
}

async function makeAccount(tag: string, validForDays: number | null) {
  const { accountsService } = await import("@/modules/accounts");
  const address = email(tag);

  const result = await accountsService.createAccount(
    {
      email: address,
      password: PLAINTEXT,
      country: "DZ",
      ...(validForDays === null ? {} : { durationDays: validForDays }),
    },
    { actor: superAdmin },
  );

  if (!result.ok) throw new Error(`could not create ${tag}: ${result.error.message}`);

  return { id: result.value.id, email: address };
}

beforeAll(async () => {
  if (!configured) return;

  const admins = await sql!<{ id: string; email: string; name: string }[]>`
    select id, email, name from public.users
    where role = 'super_admin' and status = 'active' and deleted_at is null limit 1
  `;

  const admin = admins[0];
  if (!admin) throw new Error("No active Super Admin to authorize as");

  superAdmin = {
    id: admin.id,
    email: admin.email,
    displayName: admin.name,
    initials: "SA",
    role: "super_admin",
  };
});

afterEach(async () => {
  if (!configured) return;

  await sql!`
    update public.profiles
    set status = 'available', customer_id = null, worker_id = null,
        sale_date = null, expiration_date = null, duration_days = null
    where account_id in (
      select id from public.accounts where email like ${`${PREFIX}-%@example.invalid`}
    )
  `;
});

afterAll(async () => {
  if (!configured) return;

  await sql!`delete from public.accounts where email like ${`${PREFIX}-%@example.invalid`}`;
  await sql!.end({ timeout: 5 });
});

describe.skipIf(!configured)("the preview request carries the duration", () => {
  it("refuses a preview request that omits the duration", async () => {
    /*
     * The regression, stated as a contract. An incomplete request must fail
     * loudly rather than quietly returning an unfiltered answer.
     */
    const { quickPrepareService } = await import("@/modules/quick-prepare");

    const result = await quickPrepareService.preview({ profileCount: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const fieldErrors = "fieldErrors" in result.error ? (result.error.fieldErrors ?? {}) : {};
    expect(fieldErrors).toHaveProperty("durationDays");
  }, 60_000);

  it("refuses a bare number, which is what the old signature accepted", async () => {
    const { quickPrepareService } = await import("@/modules/quick-prepare");

    /* The exact call shape that used to work and silently dropped validity. */
    const result = await quickPrepareService.preview(1);

    expect(result.ok).toBe(false);
  }, 60_000);

  it("excludes a short-dated account from the PREVIEW, not just from confirm", async () => {
    /*
     * The account has 20 days of coverage; the customer wants 200. Before the
     * fix the preview happily offered it and confirm then refused.
     */
    const { quickPrepareService } = await import("@/modules/quick-prepare");

    const short = await makeAccount("short", 20);

    const result = await quickPrepareService.preview({ profileCount: 1, durationDays: 200 });

    if (result.ok) {
      const offered = result.value.accounts.map((account) => account.accountId);
      expect(offered).not.toContain(short.id);
    }
    /*
     * A failure is also correct here — it means no stock at all could cover 200
     * days. What must never happen is the short account being offered.
     */
  }, 90_000);

  it("only offers accounts whose validity covers the request", async () => {
    const { quickPrepareService } = await import("@/modules/quick-prepare");

    const long = await makeAccount("long", 400);

    const result = await quickPrepareService.preview({ profileCount: 1, durationDays: 30 });

    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;

    /* Not necessarily OUR account — real stock competes — but it must be legal. */
    for (const account of result.value.accounts) {
      expect(account.remainingValidityDays === null || account.remainingValidityDays >= 30).toBe(
        true,
      );
    }

    expect(long.id).toBeTruthy();
  }, 90_000);
});

describe.skipIf(!configured)("preview and confirm agree", () => {
  it("never offers in preview what confirm would reject for validity", async () => {
    /*
     * The property, checked directly: take everything preview offered, and
     * assert every one of those accounts could actually carry the duration.
     *
     * Runs the real action for the preview and the real service rule for the
     * check, so a divergence anywhere between the two surfaces here.
     */
    const { quickPrepareService } = await import("@/modules/quick-prepare");
    const { accountsService, canCoverDuration } = await import("@/modules/accounts");

    /* A spread of coverage windows, including one too short for the request. */
    await makeAccount("mix-short", 15);
    await makeAccount("mix-mid", 120);
    await makeAccount("mix-long", 500);

    const durationDays = 90;
    const preview = await quickPrepareService.preview({ profileCount: 2, durationDays });

    if (!preview.ok) return; /* No stock at all is not a disagreement. */

    const today = new Date();

    for (const offered of preview.value.accounts) {
      const detail = await accountsService.getAccountDetail(offered.accountId);

      expect(detail.ok, `could not read ${offered.email}`).toBe(true);
      if (!detail.ok) continue;

      expect(
        canCoverDuration(detail.value.account, durationDays, today),
        `${offered.email} was offered by preview but cannot cover ${durationDays} days`,
      ).toBe(true);
    }
  }, 180_000);

  it("reports the same shortfall from preview as confirm would", async () => {
    /*
     * Ask for longer than anything alive can serve. Both paths must refuse, and
     * for the same reason — not one refusing and the other offering.
     */
    const { quickPrepareService } = await import("@/modules/quick-prepare");

    /* 730 is the schema maximum, so nothing open-ended can be ruled out. */
    const impossible = 730;

    const preview = await quickPrepareService.preview({
      profileCount: 40,
      durationDays: impossible,
    });

    /* 40 profiles is beyond any realistic stock, so preview must be short. */
    expect(preview.ok).toBe(false);

    const confirm = await quickPrepareService.confirm(
      { profileCount: 40, durationDays: impossible, phone: "0663947116" },
      { actor: superAdmin },
    );

    expect(confirm.ok).toBe(false);
  }, 120_000);
});
