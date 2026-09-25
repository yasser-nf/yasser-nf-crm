import { identifierSearchKeys } from "@/lib/phone";
import { PROBLEM_TYPE_LABELS } from "@/shared/ui/problem-badges";
import { escapeLike } from "@/utils/like";

/**
 * Turning what someone typed into what the search queries look for.
 *
 * Pure and client-safe: the search box uses the same length rules to decide
 * whether to ask at all, and the tests pin the matching without a database.
 */

/**
 * Below two characters every group matches most of its table, which is noise
 * for the reader and a full scan for the database. One character is refused
 * rather than answered badly.
 */
export const SEARCH_MIN_LENGTH = 2;

/** Anything longer is not a search term; it is a paste accident. */
export const SEARCH_MAX_LENGTH = 100;

/** Results shown per group. One more is fetched to know whether more exist. */
export const SEARCH_GROUP_LIMIT = 5;

/** Problem types are matched by name only from this length: "in" is not "invalid email". */
const TYPE_MATCH_MIN_LENGTH = 3;

/** An id fragment long enough to be deliberate: eight hex characters, the first uuid group. */
const ID_FRAGMENT = /^[0-9a-f]{8}(?:-[0-9a-f-]{0,28})?$/i;

export interface SearchTerms {
  /** The trimmed query, as typed. */
  readonly text: string;
  /** `%text%` with LIKE's own wildcards escaped, for case-insensitive contains. */
  readonly contains: string;
  /** `text%`, escaped: ranks a match at the start above one in the middle. */
  readonly startsWith: string;
  /** Substrings of `customers.phone_normalized`, from the Phone Engine. */
  readonly phoneKeys: readonly string[];
  /** Problem types whose key or label contains the query. */
  readonly problemTypes: readonly string[];
  /** `fragment%` when the query looks like the start of an id, else null. */
  readonly idPrefix: string | null;
}

/* Escaping lives in utils/like.ts, shared with the Logs search (M06). */
export { escapeLike };

/** The query as the service will use it, or null when it is too short to search. */
export function normalizeQuery(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");

  if (text.length < SEARCH_MIN_LENGTH) {
    return null;
  }

  return text.slice(0, SEARCH_MAX_LENGTH);
}

export function matchingProblemTypes(text: string): string[] {
  if (text.length < TYPE_MATCH_MIN_LENGTH) {
    return [];
  }

  const needle = text.toLowerCase();

  return Object.entries(PROBLEM_TYPE_LABELS)
    .filter(
      ([key, label]) =>
        label.toLowerCase().includes(needle) || key.replace(/_/g, " ").includes(needle),
    )
    .map(([key]) => key);
}

export function buildSearchTerms(text: string): SearchTerms {
  const escaped = escapeLike(text);

  return {
    text,
    contains: `%${escaped}%`,
    startsWith: `${escaped}%`,
    phoneKeys: identifierSearchKeys(text).map((key) => `%${escapeLike(key)}%`),
    problemTypes: matchingProblemTypes(text),
    idPrefix: ID_FRAGMENT.test(text) ? `${text.toLowerCase()}%` : null,
  };
}
