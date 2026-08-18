/**
 * Clipboard Engine.
 *
 * 02_ARCHITECTURE.md names this module and requires standardised output. The
 * format lives here once so every screen that copies credentials produces
 * identical text — a worker pasting into WhatsApp should never have to wonder
 * which screen it came from.
 *
 * Pure formatting. Nothing here reads state or decides anything.
 */

export interface ProfileCredential {
  readonly profileNumber: number;
  readonly pin: string | null;
  readonly profileName: string | null;
}

export interface AccountCredential {
  readonly email: string;
  /** Plaintext, already decrypted by the service. Never logged. */
  readonly password: string;
  readonly profiles: readonly ProfileCredential[];
}

/**
 * The delivery block a customer receives.
 *
 * Matches the layout specified in the M04 brief:
 *
 *   example@email.com
 *   password
 *
 *   Profile : 2
 *   PIN : 9121
 *
 * Spacing around the colon is deliberate and matches the brief. It reads
 * clearly in WhatsApp, where a bare colon can collide with an emoji shortcode.
 */
export function formatAccountCredentials(account: AccountCredential): string {
  const lines: string[] = [account.email, account.password];

  for (const profile of account.profiles) {
    lines.push("");
    lines.push(`Profile : ${profile.profileNumber}`);
    lines.push(`PIN : ${profile.pin ?? "—"}`);
  }

  return lines.join("\n");
}

/**
 * The full block for a preparation that spans more than one account.
 *
 * Accounts are separated by a rule so a customer can tell where one set of
 * credentials ends and the next begins. A single account produces no rule at
 * all — the common case stays clean.
 */
export function formatPreparation(accounts: readonly AccountCredential[]): string {
  return accounts.map(formatAccountCredentials).join("\n\n———\n\n");
}

/** Just the password. Used by the account details screen. */
export function formatPassword(password: string): string {
  return password;
}

/**
 * Email and password only, labelled, for the accounts list and detail screens.
 *
 * The exact block the M13 brief specifies:
 *
 *   Email
 *   someone@example.com
 *
 *   Password
 *   the-password
 *
 * Distinct from `formatAccountCredentials`, which is the customer-facing
 * delivery block and carries profile numbers and PINs. This one is what an
 * operator pastes when they need the credentials alone — labelled, because it
 * often lands in a note beside other text where a bare pair is ambiguous.
 */
export function formatEmailAndPassword(email: string, password: string): string {
  return `Email\n${email}\n\nPassword\n${password}`;
}

/**
 * One prepared profile, in the exact layout M13 §6 specifies.
 *
 *   Email
 *   someone@example.com
 *
 *   Password
 *   the-password
 *
 *   Profile number
 *   2
 *
 *   Code pin
 *   9121
 *
 * Distinct from `formatAccountCredentials`, which is the older delivery block
 * using `Profile : 2` / `PIN : 9121`. Both are kept because both are specified:
 * that one by the M04 brief and this one by M13 §6, and silently changing the
 * older format would alter every message the existing screens produce.
 */
export function formatPreparedProfile(profile: {
  readonly email: string;
  readonly password: string;
  readonly profileNumber: number;
  readonly pin: string | null;
}): string {
  return [
    "Email",
    profile.email,
    "",
    "Password",
    profile.password,
    "",
    "Profile number",
    String(profile.profileNumber),
    "",
    "Code pin",
    profile.pin ?? "—",
  ].join("\n");
}

/** Customer contact line, for pasting into a note or a message. */
export function formatCustomer(customer: {
  readonly displayPhone: string;
  readonly whatsappUrl: string;
}): string {
  return `${customer.displayPhone}\n${customer.whatsappUrl}`;
}

/**
 * Writes text to the clipboard.
 *
 * Returns whether it worked rather than throwing. The Clipboard API rejects
 * without a user gesture, over plain HTTP, and when the document is not focused
 * — all ordinary conditions the caller should report calmly rather than treat as
 * a crash.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return false;
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
