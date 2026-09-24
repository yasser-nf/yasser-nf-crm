/**
 * Connection pool sizing.
 *
 * Deliberately a separate module with no imports and no side effects, so the
 * numbers below can be asserted by a unit test without constructing a client,
 * reading the environment, or opening a socket.
 *
 * The sizing question is not "how many connections does one instance want" but
 * "how many can every instance want at once". Supabase's pooler enforces a
 * single project-wide budget, and each warm serverless instance, dev server and
 * test run draws from it. See `MAX_POOL_SIZE` for the arithmetic that failed.
 */

/**
 * Supavisor's session-mode client cap for this project.
 *
 * Not a guess and not a target — it is the number the pooler itself reports
 * when it starts refusing connections:
 *
 *   XX000  max clients reached in session mode -
 *          max clients are limited to pool_size: 15
 */
export const POOLER_SESSION_LIMIT = 15;

/**
 * Concurrent serverless instances this configuration must survive.
 *
 * Vercel decides how many instances to run and never promises a ceiling, so
 * this is the number the pool is sized to tolerate rather than a number anyone
 * can enforce. Production logs showed three instances serving a single
 * operator's browsing, so four is the minimum honest floor.
 */
export const SUPPORTED_CONCURRENT_INSTANCES = 4;

/**
 * Connections one instance may hold.
 *
 * At 10 the arithmetic never worked: two busy instances could ask for 20 of the
 * 15 available, and the pooler refuses the surplus outright rather than queuing
 * it. Whichever query ran first absorbed the rejection, which in practice meant
 * the session lookup that precedes every request — so a connection shortage
 * surfaced as pages failing to load and, because the lookup fails closed, as
 * widgets claiming the operator's role had lost access.
 *
 * Three leaves room for `SUPPORTED_CONCURRENT_INSTANCES` and still holds a
 * margin under the cap for a dev server or a test run.
 *
 * The smaller pool does not starve a page that fans out to many queries:
 * postgres-js queues past the limit instead of failing, and with the functions
 * running next to the database a query costs about two milliseconds, so waiting
 * for a slot costs microseconds where exhaustion cost the whole request.
 */
export const MAX_POOL_SIZE = 3;

/**
 * Seconds an unused connection is kept before it is handed back.
 *
 * A warm instance between requests should not sit on connections its siblings
 * need. Twenty seconds is most of an idle instance's life; five returns the
 * slot promptly, and reconnecting in-region is cheap.
 */
export const IDLE_TIMEOUT_SECONDS = 5;

/** Seconds to wait for a new connection before giving up. */
export const CONNECT_TIMEOUT_SECONDS = 10;

/**
 * The pool ceiling actually used: `MAX_POOL_SIZE`, or LESS if asked.
 *
 * Exists for exactly one caller — the isolated test database. That is an
 * in-process PGlite, single-session underneath, reached through a socket
 * multiplexer; several concurrent pool connections interleave their bound
 * parameters on that one session (observed: SQLSTATE 22P02 on a valid query).
 * The integration run sets DB_POOL_MAX=1 so the application talks to it through
 * one connection, as it would through any single-session database.
 *
 * It can only LOWER the ceiling. Anything missing, non-numeric, below 1 or
 * above MAX_POOL_SIZE yields MAX_POOL_SIZE, so no environment variable can
 * push an instance past the pooler budget the constants above protect.
 * Production never sets it and is unaffected.
 *
 * Pure: the caller passes the value in. This module still reads nothing.
 */
export function resolvePoolMax(requested: string | undefined): number {
  const parsed = Number(requested);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_POOL_SIZE) {
    return MAX_POOL_SIZE;
  }

  return parsed;
}

export const poolOptions = {
  /* Supabase's pooler does not support prepared statements in transaction mode. */
  prepare: false,
  max: MAX_POOL_SIZE,
  idle_timeout: IDLE_TIMEOUT_SECONDS,
  connect_timeout: CONNECT_TIMEOUT_SECONDS,
};
