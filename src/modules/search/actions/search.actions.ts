"use server";

import { getCurrentUser } from "@/lib/auth/session";
import { searchService } from "../services/search.service";
import type { SearchResponse } from "../services/search-types";

/**
 * Global search Server Action. ADR-006 Decision 3: the network boundary.
 *
 * The caller is resolved here, on the server, and every permission decision is
 * the service's. The browser sends only the text it typed.
 */

export type SearchActionResult =
  | { readonly ok: true; readonly data: SearchResponse }
  | { readonly ok: false; readonly message: string; readonly code: string };

export async function globalSearchAction(query: string): Promise<SearchActionResult> {
  const result = await searchService.search(query, await getCurrentUser());

  return result.ok
    ? { ok: true, data: result.value }
    : { ok: false, message: result.error.userMessage, code: result.error.code };
}
