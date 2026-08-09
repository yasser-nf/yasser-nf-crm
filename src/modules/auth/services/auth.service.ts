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
import { loginSchema, type LoginInput } from "../validation/login.schema";

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

export const authService = { signIn, signOut } as const;
