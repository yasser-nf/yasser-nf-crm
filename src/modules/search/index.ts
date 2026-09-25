/**
 * Global search module — public API. ADR-003 Rule 2.
 *
 * The repository is NOT exported. Each of its queries is safe only behind the
 * per-group permission check in `searchService`; handing it out would let a
 * caller skip that check.
 */
export { searchService } from "./services/search.service";
export {
  SEARCH_GROUP_LIMIT,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  buildSearchTerms,
  escapeLike,
  matchingProblemTypes,
  normalizeQuery,
  type SearchTerms,
} from "./services/search-terms";
export type {
  SearchBadge,
  SearchGroup,
  SearchGroupKind,
  SearchHit,
  SearchResponse,
} from "./services/search-types";
export { GlobalSearch } from "./components/global-search";
