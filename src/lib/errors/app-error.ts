/**
 * Centralized error hierarchy.
 *
 * ADR-003 Rule 4: every application error inherits from AppError.
 *
 * The user-facing message belongs to the error, not to the screen. The same
 * failure must read identically wherever it surfaces, and a message defined
 * once cannot drift between pages.
 *
 * 01_MASTER_RULES.md: never expose stack traces or technical details. The
 * technical `message` is for logs. `userMessage` is the only text a person
 * should ever see.
 */

import { describeCause, scrubErrorText } from "./log-safe";

/** Matches the severity ladder in 05_DEVELOPMENT_WORKFLOW.md. */
export type ErrorSeverity = "low" | "medium" | "high" | "critical";

export interface AppErrorOptions {
  /** Overrides the class default when a situation needs specific wording. */
  readonly userMessage?: string;
  /** The underlying failure. Logged, never shown. */
  readonly cause?: unknown;
  /** Structured detail for logs. Must never contain secrets. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export abstract class AppError extends Error {
  /** Stable machine-readable identifier. Safe to log, never shown to a user. */
  abstract readonly code: string;

  abstract readonly severity: ErrorSeverity;

  /** Shown to the user when no override is supplied. */
  protected abstract readonly defaultUserMessage: string;

  /**
   * True when the error is an expected condition the system knows how to
   * handle. False marks a genuine defect worth alerting on.
   */
  readonly isOperational: boolean = true;

  readonly context: Readonly<Record<string, unknown>> | undefined;

  readonly #userMessageOverride: string | undefined;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });

    this.name = new.target.name;
    this.#userMessageOverride = options.userMessage;
    this.context = options.context;

    // Keep the constructor itself out of the reported stack.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, new.target);
    }
  }

  /** The only error text that may be rendered. */
  get userMessage(): string {
    return this.#userMessageOverride ?? this.defaultUserMessage;
  }

  /**
   * Log-safe representation. Deliberately excludes the stack trace.
   *
   * The cause is described, never stringified: `String(cause)` on a failed
   * Drizzle query is "Failed query: … params: <every bound value>", which wrote
   * PINs and whole audit snapshots to the logs (M06). See log-safe.ts.
   */
  toLogObject(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      severity: this.severity,
      message: scrubErrorText(this.message),
      isOperational: this.isOperational,
      ...(this.context ? { context: this.context } : {}),
      ...(this.cause ? { cause: describeCause(this.cause) } : {}),
    };
  }
}

/** Input failed validation. */
export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR";
  readonly severity: ErrorSeverity = "low";
  protected readonly defaultUserMessage = "Please check the information you entered and try again.";

  /** Field-level messages, keyed by field name, for form display. */
  readonly fieldErrors: Readonly<Record<string, string>> | undefined;

  constructor(
    message: string,
    options: AppErrorOptions & { readonly fieldErrors?: Readonly<Record<string, string>> } = {},
  ) {
    super(message, options);
    this.fieldErrors = options.fieldErrors;
  }
}

/**
 * The requested record does not exist.
 *
 * ADR-003: absence is not an exception. This is carried by a Failure, not
 * thrown.
 */
export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND";
  readonly severity: ErrorSeverity = "low";
  protected readonly defaultUserMessage = "We could not find what you were looking for.";
}

/** The operation conflicts with existing data, such as a duplicate. */
export class ConflictError extends AppError {
  readonly code = "CONFLICT";
  readonly severity: ErrorSeverity = "medium";
  protected readonly defaultUserMessage = "This conflicts with something that already exists.";
}

/** No valid session. The user must sign in. */
export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED";
  readonly severity: ErrorSeverity = "medium";
  protected readonly defaultUserMessage = "Your session has ended. Please sign in again.";
}

/** Authenticated, but the role does not permit this action. */
export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN";
  readonly severity: ErrorSeverity = "high";
  protected readonly defaultUserMessage = "You do not have permission to do that.";
}

/**
 * A database operation failed.
 *
 * Created only by the Database Adapter. Raw PostgreSQL errors die at that
 * boundary and never travel upward. See ADR-003.
 */
export class DatabaseError extends AppError {
  readonly code = "DATABASE_ERROR";
  readonly severity: ErrorSeverity = "critical";
  override readonly isOperational: boolean = false;
  /*
   * Deliberately says nothing about saving.
   *
   * Every read goes through the same adapter as every write, so this default
   * lands on failed queries just as often as on failed mutations. Claiming a
   * save was attempted told operators that a dashboard which only reads had
   * lost their changes — alarming, and false. Callers that really are saving
   * still pass a specific `userMessage`.
   *
   * Distinct from UnexpectedError's wording on purpose: an operator who
   * reports what they saw should be pointing at the database rather than at
   * the generic fallback.
   *
   * The wording is the only thing softened here. The error still surfaces, is
   * still `critical`, and is still logged with its cause attached.
   */
  protected readonly defaultUserMessage =
    "Something went wrong while accessing data. Please try again.";
}

/** A third-party service failed or was unreachable. */
export class ExternalServiceError extends AppError {
  readonly code = "EXTERNAL_SERVICE_ERROR";
  readonly severity: ErrorSeverity = "high";
  protected readonly defaultUserMessage =
    "A service we depend on is not responding. Please try again in a moment.";
}

/** Configuration is missing or invalid. Always a deployment defect. */
export class ConfigurationError extends AppError {
  readonly code = "CONFIGURATION_ERROR";
  readonly severity: ErrorSeverity = "critical";
  override readonly isOperational: boolean = false;
  protected readonly defaultUserMessage =
    "The application is not configured correctly. Please contact your administrator.";
}

/**
 * Last-resort fallback for a genuinely unexpected failure.
 *
 * 01_MASTER_RULES.md lists "Something Went Wrong" among account statuses; this
 * is the equivalent for errors — used when nothing more specific applies.
 */
export class UnexpectedError extends AppError {
  readonly code = "UNEXPECTED_ERROR";
  readonly severity: ErrorSeverity = "critical";
  override readonly isOperational: boolean = false;
  protected readonly defaultUserMessage = "Something went wrong. Please try again.";
}

/**
 * An error rebuilt on the client from a Server Action's response.
 *
 * ADR-006 Decision 3: a Result carries an AppError instance, and class instances
 * do not survive the server-to-client boundary — the prototype and its methods
 * are lost. Actions therefore return a plain envelope, and the hook layer turns
 * it back into a real AppError here.
 *
 * That restoration matters: it is what lets `ErrorState`, `isAppError` and the
 * TanStack Query retry policy keep working unchanged for data that arrived over
 * the wire.
 */
export class ActionError extends AppError {
  readonly code: string;
  readonly severity: ErrorSeverity = "medium";
  protected readonly defaultUserMessage: string;

  /** Field-level messages, when the server reported a validation failure. */
  readonly fieldErrors: Readonly<Record<string, string>> | undefined;

  constructor(
    userMessage: string,
    code: string,
    fieldErrors?: Readonly<Record<string, string>> | undefined,
  ) {
    super(`Server action failed: ${code}`, { userMessage });
    this.code = code;
    this.defaultUserMessage = userMessage;
    this.fieldErrors = fieldErrors;
  }
}

/** Narrowing helper for values crossing an untyped boundary. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Converts anything thrown into an AppError.
 *
 * Used at boundaries where a third party may throw arbitrary values, so that
 * everything downstream can rely on the hierarchy.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) {
    return value;
  }

  if (value instanceof Error) {
    /* Scrubbed: a wrapped query error's message carries its bound values. */
    return new UnexpectedError(scrubErrorText(value.message), { cause: value });
  }

  return new UnexpectedError(String(value), { cause: value });
}
