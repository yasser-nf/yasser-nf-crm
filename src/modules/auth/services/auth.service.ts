import type { AuthError } from "@supabase/supabase-js";

import { isSupabaseConfigured } from "@/config/env";
import { toAuthIdentity, type AuthIdentity } from "@/lib/auth";
import {
  ConfigurationError,
  ExternalServiceError,
  UnauthorizedError,
  ValidationError,
  toAppError,
  type AppError,
} from "@/lib/errors";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Result, VoidResult } from "@/types/result";
import { fail, ok } from "@/utils/result";
import {
  buildChangePasswordSchema,
  type ChangePasswordInput,
} from "../validation/change-password.schema";
import { loginSchema, type LoginInput } from "../validation/login.schema";
import { buildSetPasswordSchema, type SetPasswordInput } from "../validation/set-password.schema";

/**
 * Authentication service.
 *
 * ADR-003 Rule 3: returns Result, never throws for an expected outcome. A wrong
 * password is not exceptional â€” it is the single most common thing that happens
 * on a login form.
 *
 * 05_DEVELOPMENT_WORKFLOW.md requires services to be pure business logic with no
 * UI and to be independently testable. Nothing here renders or reads the DOM.
 */

/** Supabase status codes worth distinguishing from a generic failure. */
const AUTH_STATUS = {
  INVALID_CREDENTIALS: 400,
  RATE_LIMITED: 429,
} as const;

/**
 * Translates a Supabase auth failure into an AppError.
 *
 * Deliberately does not reveal whether the email exists. Distinguishing "no such
 * account" from "wrong password" hands an attacker a way to enumerate valid
 * addresses, so both produce identical wording.
 */
function translateAuthError(error: AuthError): AppError {
  if (error.status === AUTH_STATUS.RATE_LIMITED) {
    return new ExternalServiceError(`Auth rate limited: ${error.message}`, {
      cause: error,
      userMessage: "Too many attempts. Please wait a moment and try again.",
    });
  }

  if (error.status === AUTH_STATUS.INVALID_CREDENTIALS) {
    return new UnauthorizedError(`Sign-in rejected: ${error.message}`, {
      cause: error,
      userMessage: "Email or password is incorrect.",
    });
  }

  return new ExternalServiceError(`Auth request failed: ${error.message}`, {
    cause: error,
    userMessage: "We could not sign you in right now. Please try again.",
  });
}

const NOT_CONFIGURED_MESSAGE =
  "Sign-in is unavailable because the Supabase connection has not been configured yet.";

/**
 * Signs a user in with email and password.
 *
 * Input is revalidated here rather than trusted from the form. 02_ARCHITECTURE.md:
 * never trust frontend validation.
 */
async function signIn(input: LoginInput): Promise<Result<AuthIdentity>> {
  const parsed = loginSchema.safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }

    return fail(new ValidationError("Login input failed validation", { fieldErrors }));
  }

  if (!isSupabaseConfigured()) {
    return fail(
      new ConfigurationError("Supabase is not configured", {
        userMessage: NOT_CONFIGURED_MESSAGE,
      }),
    );
  }

  try {
    const supabase = createSupabaseBrowserClient();

    const { data, error } = await supabase.auth.signInWithPassword({
      email: parsed.data.email,
      password: parsed.data.password,
    });

    if (error) {
      return fail(translateAuthError(error));
    }

    /*
     * Returns the identity, not an AppUser.
     *
     * Since M04.9 an AppUser carries a role, and the role lives in public.users.
     * Building one here would mean the browser inventing an authorization
     * claim. The server resolves the role on the next render, and refuses the
     * session entirely if no active CRM record exists.
     */
    const identity = toAuthIdentity(data.user);

    if (!identity) {
      return fail(
        new UnauthorizedError("Authenticated user has no email address", {
          userMessage: "This account cannot be used to sign in. Please contact your administrator.",
        }),
      );
    }

    return ok(identity);
  } catch (caught) {
    return fail(toAppError(caught));
  }
}

/**
 * Ends the current session.
 *
 * Reports failure rather than swallowing it. A sign-out that silently fails
 * leaves someone believing they are signed out when they are not, which on a
 * shared machine is a security problem.
 */
async function signOut(): Promise<VoidResult> {
  if (!isSupabaseConfigured()) {
    return fail(
      new ConfigurationError("Supabase is not configured", {
        userMessage: NOT_CONFIGURED_MESSAGE,
      }),
    );
  }

  try {
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.signOut();

    if (error) {
      return fail(translateAuthError(error));
    }

    return ok();
  } catch (caught) {
    return fail(toAppError(caught));
  }
}

/**
 * Changes the signed-in user's own password.
 *
 * Two steps, and the first is the one Supabase does not do for you.
 * `updateUser({ password })` succeeds on any valid session without ever asking
 * what the old password was — so on an unattended, unlocked machine anyone
 * could set a new one. Re-authenticating first is what makes "current password"
 * mean something, and it is the only way to verify it: there is no compare-only
 * endpoint, and the hash is never exposed to a client.
 *
 * The re-authentication issues a fresh session for the same user, which is
 * harmless and is what Supabase's own guidance describes.
 *
 * NOTHING HERE IS STORED OR LOGGED. The two passwords exist as arguments and in
 * the request body. No console call, no logger, no field on any error, and the
 * validation error paths carry field names only — never values.
 */
async function changePassword(
  input: ChangePasswordInput,
  context: { readonly email: string; readonly passwordMinLength: number },
): Promise<VoidResult> {
  /* Revalidated against the SAME policy the form used. */
  const parsed = buildChangePasswordSchema(context.passwordMinLength).safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }

    return fail(new ValidationError("Change password input failed validation", { fieldErrors }));
  }

  if (!isSupabaseConfigured()) {
    return fail(
      new ConfigurationError("Supabase is not configured", {
        userMessage: NOT_CONFIGURED_MESSAGE,
      }),
    );
  }

  try {
    const supabase = createSupabaseBrowserClient();

    /*
     * There must already be a session. Checked explicitly rather than left to
     * `updateUser` to refuse, so an expired session says so plainly instead of
     * failing as though the password were wrong.
     */
    const { data: session } = await supabase.auth.getSession();

    if (!session.session) {
      return fail(
        new UnauthorizedError("No active session for a password change", {
          userMessage: "Your session has expired. Sign in again to change your password.",
        }),
      );
    }

    /* Step 1: prove the current password. */
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: context.email,
      password: parsed.data.currentPassword,
    });

    if (reauthError) {
      /*
       * A rejected re-authentication here means one thing only — the current
       * password is wrong. The email is the session's own, so the ambiguity
       * `translateAuthError` protects against on the login form does not exist,
       * and naming the field puts the message where the mistake is.
       */
      if (reauthError.status === AUTH_STATUS.INVALID_CREDENTIALS) {
        /*
         * A ValidationError rather than an UnauthorizedError, deliberately.
         * The session is valid — the user is who they say they are; what failed
         * is a value they typed into a field. That is a validation failure, and
         * it is also the only error class carrying `fieldErrors`, which is what
         * puts the message under the right input.
         */
        return fail(
          new ValidationError("Current password rejected", {
            cause: reauthError,
            userMessage: "Your current password is not correct.",
            fieldErrors: { currentPassword: "This is not your current password" },
          }),
        );
      }

      return fail(translateAuthError(reauthError));
    }

    /* Step 2: only now set the new one. */
    const { error: updateError } = await supabase.auth.updateUser({
      password: parsed.data.newPassword,
    });

    if (updateError) {
      /*
       * Supabase enforces its own project-level policy on top of ours, and its
       * wording is the only place that knows what it refused.
       */
      if (updateError.status === AUTH_STATUS.INVALID_CREDENTIALS) {
        return fail(
          new ValidationError("Supabase refused the new password", {
            cause: updateError,
            userMessage: updateError.message,
            fieldErrors: { newPassword: updateError.message },
          }),
        );
      }

      return fail(translateAuthError(updateError));
    }

    return ok();
  } catch (caught) {
    return fail(toAppError(caught));
  }
}

/**
 * Sets the first password for somebody who arrived from an invitation.
 *
 * Separate from `changePassword` because the two guard different things.
 * changePassword re-authenticates with the CURRENT password before setting a
 * new one, which is what stops an unattended, already-signed-in browser being
 * used to take an account over. An invited person has no current password, so
 * that check cannot be the guard here.
 *
 * What guards this instead is the session itself. Supabase issued it seconds
 * earlier, in exchange for a single-use invitation token that it verified and
 * consumed. Holding it is proof of controlling the invited mailbox. Without one,
 * this refuses — so the page being reachable without signing in does not make
 * the action reachable without an invitation.
 *
 * The email is never taken from a form or a URL: `updateUser` acts on whoever
 * the session says the caller is. There is no parameter here through which a
 * recipient could name a different account, and no role parameter at all — the
 * role was set by the administrator who sent the invitation.
 *
 * As with changePassword, no password value is logged, returned, or attached to
 * an error. Field errors carry field names only.
 */
async function setInitialPassword(
  input: SetPasswordInput,
  context: { readonly passwordMinLength: number },
): Promise<VoidResult> {
  /* Revalidated against the SAME configured policy the form used. */
  const parsed = buildSetPasswordSchema(context.passwordMinLength).safeParse(input);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};

    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === "string" && !(field in fieldErrors)) {
        fieldErrors[field] = issue.message;
      }
    }

    return fail(new ValidationError("Set password input failed validation", { fieldErrors }));
  }

  if (!isSupabaseConfigured()) {
    return fail(
      new ConfigurationError("Supabase is not configured", {
        userMessage: NOT_CONFIGURED_MESSAGE,
      }),
    );
  }

  try {
    const supabase = createSupabaseBrowserClient();

    /*
     * The whole authorization check, in one call. An expired or absent session
     * means the invitation was never completed, or was completed too long ago.
     */
    const { data: session } = await supabase.auth.getSession();

    if (!session.session) {
      return fail(
        new UnauthorizedError("No session when setting an initial password", {
          userMessage:
            "Your invitation link is no longer active. Ask an administrator to send you a new one.",
        }),
      );
    }

    const { error: updateError } = await supabase.auth.updateUser({
      password: parsed.data.newPassword,
    });

    if (updateError) {
      if (updateError.status === AUTH_STATUS.INVALID_CREDENTIALS) {
        /* Supabase's project password policy, on top of ours. Its wording is
           the only place that knows what it refused. */
        return fail(
          new ValidationError("Supabase refused the new password", {
            cause: updateError,
            userMessage: updateError.message,
            fieldErrors: { newPassword: updateError.message },
          }),
        );
      }

      return fail(translateAuthError(updateError));
    }

    return ok();
  } catch (caught) {
    return fail(toAppError(caught));
  }
}

export const authService = { signIn, signOut, changePassword, setInitialPassword } as const;
