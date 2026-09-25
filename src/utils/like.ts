/**
 * Escapes LIKE's wildcards so they match literally.
 *
 * Without it "a_b" would match "axb", and a query of "%" would match every row
 * of every table — a trivially expensive search anyone could type. PostgreSQL's
 * default LIKE escape character is the backslash, so no ESCAPE clause is needed.
 *
 * Shared by global search (M05) and the Logs search (M06), so there is one rule
 * for what a typed wildcard means. Pure and client-safe.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
