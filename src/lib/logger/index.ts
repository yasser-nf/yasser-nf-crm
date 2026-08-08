import { isAppError } from "@/lib/errors";

/**
 * Application logger.
 *
 * 01_MASTER_RULES.md: never expose secrets. Nothing here ever writes a raw
 * error object, because a raw error can carry a connection string in its
 * message. AppError instances are serialized through their log-safe shape.
 *
 * This is a thin wrapper over the console on purpose. It exists so that adding
 * a real log sink later is one file, not a search across the codebase. The
 * Audit Log described in 01_MASTER_RULES.md is a separate, immutable concern
 * and belongs to its own milestone.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

type LogContext = Readonly<Record<string, unknown>>;

function write(level: LogLevel, message: string, context?: LogContext): void {
  const entry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(context ? { context } : {}),
  };

  const serialized = JSON.stringify(entry);

  switch (level) {
    case "error":
      console.error(serialized);
      break;
    case "warn":
      console.warn(serialized);
      break;
    default:
      console.log(serialized);
  }
}

export const logger = {
  debug(message: string, context?: LogContext): void {
    if (process.env.NODE_ENV === "production") {
      return;
    }
    write("debug", message, context);
  },

  info(message: string, context?: LogContext): void {
    write("info", message, context);
  },

  warn(message: string, context?: LogContext): void {
    write("warn", message, context);
  },

  /**
   * Logs a failure. Unknown values are stringified rather than spread, so a
   * third-party error object cannot leak fields we have not inspected.
   */
  error(message: string, error?: unknown, context?: LogContext): void {
    const errorDetail = isAppError(error)
      ? error.toLogObject()
      : error === undefined
        ? undefined
        : { message: String(error) };

    write("error", message, {
      ...context,
      ...(errorDetail ? { error: errorDetail } : {}),
    });
  },
} as const;
