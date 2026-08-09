/**
 * Client-safe auth surface.
 *
 * `session.ts` is deliberately NOT re-exported. It imports `server-only`, so
 * barrelling it would break the build for any client component that only wanted
 * the AppUser type. Server code imports `@/lib/auth/session` directly.
 */
export {
  deriveInitials,
  toAppUser,
  toAuthIdentity,
  type AppUser,
  type AuthIdentity,
} from "./app-user";
