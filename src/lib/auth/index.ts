/**
 * Client-safe auth surface.
 *
 * `session.ts` is deliberately NOT re-exported here. It imports `server-only`,
 * so barrelling it would break the build for any client component that only
 * wanted the AppUser type. Server code imports `@/lib/auth/session` directly.
 */
export { toAppUser, type AppUser } from "./app-user";
