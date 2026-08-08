/**
 * Test stub for the `server-only` package.
 *
 * The real module throws when imported outside a React Server Component, which
 * is exactly the guarantee we want in the application and exactly what prevents
 * a unit test from importing a module barrel.
 *
 * Stubbing it here does not weaken the production guarantee: the alias applies
 * only to the Vitest run. The build still fails if a client component imports a
 * server module.
 */
export {};
