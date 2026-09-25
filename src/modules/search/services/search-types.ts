/**
 * What a search returns to the browser. Client-safe: types only.
 *
 * Deliberately presentational. Every field is something the result row shows;
 * nothing is sent "in case". The badge is decided on the server from the same
 * derivations every other screen uses — `accountEffectiveStatus`,
 * `profileCellState`, the problem lifecycle — so a search result can never show
 * a state its own page would contradict.
 */

export type SearchGroupKind = "accounts" | "profiles" | "customers" | "problems" | "users";

export interface SearchBadge {
  readonly label: string;
  /** From the design system's own style maps, never from data. */
  readonly className: string;
}

export interface SearchHit {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly href: string;
  readonly badge: SearchBadge | null;
}

export type SearchGroup =
  | {
      readonly kind: SearchGroupKind;
      readonly label: string;
      readonly status: "ok";
      readonly hits: readonly SearchHit[];
      /** More matched than are shown. */
      readonly hasMore: boolean;
      /** The entity's own list, filtered by the same text — only where one exists. */
      readonly viewAllHref: string | null;
    }
  | {
      readonly kind: SearchGroupKind;
      readonly label: string;
      /** This group's query failed. The others may still have answered. */
      readonly status: "error";
    };

export interface SearchResponse {
  readonly query: string;
  /** Only the groups this person may search, in a fixed order. */
  readonly groups: readonly SearchGroup[];
}
