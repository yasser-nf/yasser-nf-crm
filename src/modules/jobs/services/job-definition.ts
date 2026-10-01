import type { z } from "zod";

import { ValidationError } from "@/lib/errors";
import { isSensitiveKey } from "@/modules/audit";
import type { Result } from "@/types/result";
import type { JobPriorityName } from "./job-states";

/**
 * Job types (M08 jobs). docs/JOBS_MODULE.md §5.
 *
 * A job type is a value, not an entry in a global registry: the code that
 * enqueues one passes its definition, and a worker process is handed the list
 * of definitions it can run. Nothing about the queue lives in module state.
 *
 * M08 defines no production job type — it is the foundation. M09's browser
 * automation adds the first ones.
 */

export interface JobContext<P> {
  readonly jobId: string;
  readonly type: string;
  readonly idempotencyKey: string;
  /** 1 on the first claim, 2 on the first retry, … */
  readonly attempt: number;
  readonly payload: P;
  /** Aborted when the worker loses its claim — a heartbeat was refused. Stop then. */
  readonly signal: AbortSignal;
}

interface JobDefinitionBase<P> {
  /** Dotted lowercase, e.g. `netflix.verify_account`. */
  readonly type: string;
  /** References only. Validated before a job is written and again before it runs. */
  readonly payload: z.ZodType<P>;
  readonly maxAttempts?: number;
  readonly priority?: JobPriorityName;

  /** Does the work. Returns safe metadata (references, counts) or a failure. */
  run(context: JobContext<P>): Promise<Result<Record<string, unknown>>>;
}

/**
 * How stale recovery may judge this job type — REQUIRED, one or the other.
 *
 * A worker that stops responding leaves a job that may or may not have done its
 * work. Recovery must never guess: re-running a committed sale would sell
 * twice. So every type says, at definition time, how its work can be judged:
 *
 *   receipt      where the business operation records its receipt (the
 *                idempotency module). Recovery reads it: committed ⇒ the job is
 *                marked succeeded and never re-run. The handler MUST claim that
 *                receipt inside its own transaction.
 *   retryOnStale re-running cannot duplicate a business effect — the job writes
 *                nothing, or its writes are idempotent on their own. Recovery
 *                may queue it again.
 *
 * A type that declares neither is unrepresentable (and `defineJob` refuses it),
 * which is why recovery has no "assume it is safe" branch.
 */
type StaleRecoveryRule<P> =
  | {
      receipt(job: { readonly idempotencyKey: string; readonly payload: P }): {
        readonly scope: string;
        readonly key: string;
      };
      readonly retryOnStale?: never;
    }
  | {
      readonly receipt?: never;
      /** The literal is a sentence the author has to mean: re-running is safe. */
      readonly retryOnStale: "re-running is safe";
    };

export type JobDefinition<P> = JobDefinitionBase<P> & StaleRecoveryRule<P>;

/** Any job type, for collections. Method syntax above keeps this assignable. */
export type AnyJobDefinition = JobDefinition<unknown>;

const TYPE_FORMAT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function defineJob<P>(definition: JobDefinition<P>): JobDefinition<P> {
  if (!TYPE_FORMAT.test(definition.type) || definition.type.length > 64) {
    throw new Error(`Invalid job type "${definition.type}"`);
  }

  /* The type system already says so; this holds for JavaScript callers too. */
  const declared = [definition.receipt !== undefined, definition.retryOnStale !== undefined];

  if (declared.filter(Boolean).length !== 1) {
    throw new Error(
      `Job type "${definition.type}" must declare exactly one of receipt() or retryOnStale: ` +
        "stale recovery cannot otherwise tell whether its work already committed",
    );
  }

  if (
    definition.maxAttempts !== undefined &&
    (!Number.isInteger(definition.maxAttempts) ||
      definition.maxAttempts < 1 ||
      definition.maxAttempts > 20)
  ) {
    throw new Error(`Job type "${definition.type}" has an invalid maxAttempts`);
  }

  return definition;
}

export type JobRegistry = ReadonlyMap<string, AnyJobDefinition>;

/** The job types one worker can run. A duplicate type is a programming error. */
export function createRegistry(definitions: readonly AnyJobDefinition[]): JobRegistry {
  const registry = new Map<string, AnyJobDefinition>();

  for (const definition of definitions) {
    if (registry.has(definition.type)) {
      throw new Error(`Job type "${definition.type}" is defined twice`);
    }
    registry.set(definition.type, definition);
  }

  return registry;
}

/** The shape `encryptSecret` produces — a ciphertext has no business in a payload either. */
const CIPHERTEXT = /^v\d+:[^:\s]+:[^:\s]+:[^:\s]+$/;

function findUnsafe(value: unknown, path: string, depth: number): string | null {
  if (depth > 8) {
    return path || "(root)";
  }

  if (typeof value === "string") {
    return CIPHERTEXT.test(value) ? path || "(root)" : null;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findUnsafe(item, `${path}[${index}]`, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const here = path ? `${path}.${key}` : key;
      if (isSensitiveKey(key)) return here;
      const found = findUnsafe(item, here, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Refuses a payload that carries a credential: a sensitive key (the audit
 * module's own rule — password, pin, token, secret, key…) at any depth, or a
 * value shaped like an encrypted secret. Jobs carry references; the worker
 * reads what it needs from the records, server-side, when it runs.
 */
export function assertSafePayload(payload: unknown): void {
  const unsafe = findUnsafe(payload, "", 0);

  if (unsafe) {
    throw new ValidationError(`Job payload carries a sensitive field (${unsafe})`, {
      userMessage: "A job cannot carry credentials. Pass a reference to the record instead.",
    });
  }
}
