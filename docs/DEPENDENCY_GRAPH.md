# Dependency Graph

Version: 1.0
Milestone: M01.5
Generated: 2026-08-08

Verified with `madge --circular` across all 59 source files: **no circular
dependencies**.

---

## 1. The Mandated Chain

ADR-003 Rule 1. Six layers. No layer may be skipped or inverted.

```
┌─────────────────────────────────────────────┐
│  APPLICATION                                │
│  src/app/ — routes, layouts, composition    │
│  Knows: which module to render              │
│  Never: business logic, SQL, direct DB       │
└──────────────────┬──────────────────────────┘
                   │  imports @/modules/<feature>
                   ▼
┌─────────────────────────────────────────────┐
│  MODULES                                    │
│  src/modules/<feature>/index.ts              │
│  The only public surface of a feature        │
│  Never: expose repositories                  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  SERVICES                                   │
│  <feature>/services/*.service.ts             │
│  DECIDES. Authorization, rules, validation   │
│  Returns Result<T>. Never throws for an      │
│  expected outcome.                           │
│  Never: touch the database                   │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  REPOSITORIES                               │
│  <feature>/repositories/*.repository.ts      │
│  Describes WHAT data is needed               │
│  Never: import Drizzle · import a sibling    │
│  STATUS: none exist — no tables yet          │
└──────────────────┬──────────────────────────┘
                   │  imports @/lib/database
                   ▼
┌─────────────────────────────────────────────┐
│  DATABASE ADAPTER                           │
│  src/lib/database/adapter.ts                 │
│  Decides HOW. Owns connection + transactions │
│  Translates SQLSTATE → AppError              │
│  THE ONLY SANCTIONED DRIZZLE IMPORTER        │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  DRIZZLE                                    │
│  src/lib/drizzle/client.ts + schema/         │
│  Server-only. Connection cached across HMR.  │
│  schema/ is EMPTY — zero tables              │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  POSTGRESQL  (Supabase-hosted)              │
│  Zero tables. Zero migrations.               │
└─────────────────────────────────────────────┘
```

### Which arrows are enforced by tooling

| Boundary                          | Enforcement                     |
| --------------------------------- | ------------------------------- |
| Application → module barrel only  | ESLint `no-restricted-imports`  |
| Repository ✗ Drizzle              | ESLint `no-restricted-imports`  |
| Repository ✗ sibling module       | ESLint `no-restricted-imports`  |
| Service ✗ database                | Review — see risk below         |
| No layer skipping                 | Review                          |

Both ESLint rules were tested with deliberate violations during M01 and rejected
the code with an ADR-003 citation.

**Open risk:** nothing mechanically stops a *service* from importing
`@/lib/database` and skipping its repository. The rule is documented but only
review-enforced. Closing it is a one-line ESLint addition once repositories
exist — until then the rule has nothing to protect.

---

## 2. Shared Dependencies

Every layer may reach these. None of them may reach back into a module. That
one-way rule is what keeps features removable.

```
                    ┌──────────────────────────┐
                    │       config/            │
                    │  env · env.server        │
                    │  constants · navigation  │
                    │  roles · theme           │
                    └────────────┬─────────────┘
                                 │
   ┌────────────┬────────────────┼──────────────┬─────────────┐
   ▼            ▼                ▼              ▼             ▼
┌────────┐ ┌─────────┐   ┌────────────┐  ┌──────────┐  ┌──────────┐
│ types/ │ │ utils/  │   │ lib/errors │  │ shared/  │  │ hooks/   │
│ result │ │ cn      │   │  AppError  │  │ ui       │  │ sidebar  │
│ tsq.d  │ │ result  │   │  ×8 + 2    │  │ layouts  │  │ store    │
└───┬────┘ └────┬────┘   └─────┬──────┘  │ forms    │  └──────────┘
    │           │              │         │ feedback │
    └───────────┴──────────────┘         └──────────┘
                │
        types/result depends on lib/errors
        utils/result depends on both
```

### Foundational dependency order

`lib/errors` sits at the bottom. Nothing it imports belongs to this project.

```
lib/errors            (no internal dependencies)
   ▲
   ├── types/result           Failure<E extends AppError>
   ├── types/tanstack-query   registers AppError as TError globally
   ├── utils/result           ok · fail · unwrap · guards
   ├── lib/logger             serializes AppError safely
   ├── lib/database/adapter   produces AppError from SQLSTATE
   ├── shared/feedback/error-state  renders userMessage only
   └── providers/query-provider     retry policy inspects error class
```

`types/tanstack-query.d.ts` is the reason no hook in the project restates its
error generic: `AppError` is registered once as the default `TError`, so
`error.userMessage` is available and type-checked everywhere.

---

## 3. Infrastructure (`lib/`)

```
lib/
├── errors/        ← depends on nothing internal. The base of everything.
│
├── logger/        → lib/errors
│
├── supabase/
│   ├── client.ts      → config/env                     [browser]
│   ├── server.ts      → config/env, next/headers       [server-only]
│   └── middleware.ts  → config/env                     [edge]
│
├── auth/
│   ├── app-user.ts  → @supabase/supabase-js types      [client-safe]
│   ├── session.ts   → lib/supabase/server, config/env  [server-only]
│   └── index.ts     → app-user ONLY  ← session deliberately excluded
│
├── drizzle/
│   ├── client.ts    → config/env.server, ./schema      [server-only]
│   └── schema/      → nothing. Empty.
│
└── database/
    └── adapter.ts   → lib/drizzle/client, lib/errors, lib/logger,
                       types/result, utils/result       [server-only]
```

### The `lib/auth` barrel omission

`lib/auth/index.ts` exports `app-user` but **not** `session`. This is deliberate
and load-bearing.

`session.ts` imports `server-only`. Any client component importing the barrel
would pull that in and fail the build — even one that only wanted the `AppUser`
type. Server code therefore imports `@/lib/auth/session` directly.

### Runtime boundary

`server-only` is a build-time guarantee, not a convention. If a client component
ever imports one of these, the build fails rather than shipping a secret.

| Module                    | Guard         |
| ------------------------- | ------------- |
| `config/env.server.ts`    | `server-only` |
| `lib/drizzle/client.ts`   | `server-only` |
| `lib/database/adapter.ts` | `server-only` |
| `lib/supabase/server.ts`  | `server-only` |
| `lib/auth/session.ts`     | `server-only` |

---

## 4. Providers

```
app/layout.tsx  [server]
   │  getCurrentUser()  ─── React cache(), one round trip per request
   ▼
AppProviders(initialUser)  [client]
   │
   ├─ ThemeProvider          → config/theme
   │     MotionConfig: 200ms default, reducedMotion="user"
   │     Outermost, so all animation inherits it
   │
   └─ QueryProvider          → lib/errors
         │  QueryClient in useState — never module scope
         │  retry: terminal AppErrors are not retried
         │  mutations: retry disabled (a retried write duplicates an order)
         │
         └─ AuthProvider     → lib/auth, lib/supabase/client
               │  useAuth() context; subscribes to onAuthStateChange
               ├─ {children}
               └─ Toaster    → shared/ui/sonner → config/theme
```

### Provider consumers

| Provider      | Consumed by                              |
| ------------- | ---------------------------------------- |
| AuthProvider  | `shared/layouts/topbar.tsx` (`useAuth`)  |
| QueryProvider | `modules/auth/hooks/*` (`useMutation`)   |
| ThemeProvider | every Framer Motion component, implicitly |

---

## 5. Module Dependencies

```
modules/auth/
│
├── index.ts ─────────────► LoginForm, useLogout (consumed)
│                           useLogin, authService,
│                           loginSchema, LoginInput (unconsumed)
│
├── components/login-form.tsx
│      → ./hooks/use-login          (relative — internal)
│      → ./validation/login.schema  (relative — internal)
│      → config/env, config/theme
│      → lib/errors  (ValidationError, for field-level errors)
│      → shared/ui/button, shared/forms/form-field
│
├── hooks/use-login.ts
│      → ./services/auth.service
│      → config/constants, utils/result
│
├── hooks/use-logout.ts
│      → ./services/auth.service
│      → config/constants, utils/result, sonner
│
├── services/auth.service.ts
│      → ./validation/login.schema
│      → config/env, lib/auth, lib/errors
│      → lib/supabase/client, types/result, utils/result
│
└── validation/login.schema.ts
       → zod
```

Note the pattern: internal files reference each other with **relative** paths.
`@/modules/auth/...` is reserved for outsiders — and ESLint blocks the deep form
of it entirely. The barrel is for consumers, not for the module's own wiring.

### Who imports the auth module

| Consumer                      | Imports      |
| ----------------------------- | ------------ |
| `app/(auth)/login/page.tsx`   | `LoginForm`  |
| `shared/layouts/topbar.tsx`   | `useLogout`  |

`shared/layouts/topbar.tsx` importing a module is worth noting: `shared/` is
meant to hold reusable UI with no business logic, and it reaches into
`@/modules/auth` for the logout mutation. It respects the barrier — it uses the
public barrel, not internals — but it is the one place where the dependency
direction is shared → module rather than module → shared. Logged as technical
debt; a cleaner arrangement passes logout in as a prop or moves the profile menu
into the auth module.

---

## 6. Removability

ADR-003 Rule 5: deleting `modules/<feature>/` must break only that feature.

**Test applied to `modules/auth/`:** deleting it would break

- `app/(auth)/login/page.tsx` — the login route it owns. Expected.
- `shared/layouts/topbar.tsx` — the logout button. **Not expected.**

So the current coupling is one edge away from clean. See the note above.

Every other dependency runs module → shared/lib/config, which is the correct
direction and leaves those layers untouched by a module's removal.

---

## 7. External Dependencies

### Production (17)

| Package                    | Used by                          |
| -------------------------- | -------------------------------- |
| `next` · `react` · `react-dom` | everywhere                   |
| `@supabase/ssr`            | `lib/supabase/*`                 |
| `@supabase/supabase-js`    | `lib/auth`, service error types  |
| `drizzle-orm`              | `lib/drizzle/client` ONLY        |
| `postgres`                 | `lib/drizzle/client` ONLY        |
| `@tanstack/react-query`    | `providers/query-provider`, hooks |
| `zustand`                  | `hooks/use-sidebar-store`        |
| `react-hook-form`          | `modules/auth/components`        |
| `@hookform/resolvers`      | same                             |
| `zod`                      | `config/env*`, validation        |
| `framer-motion`            | theme provider, sidebar, login   |
| `lucide-react`             | navigation, all icons            |
| `sonner`                   | `shared/ui/sonner`, hooks        |
| `radix-ui`                 | `shared/ui/*`                    |
| `class-variance-authority` | `shared/ui/button`               |
| `clsx` · `tailwind-merge`  | `utils/cn`                       |
| `server-only`              | 5 server modules                 |

`npm audit --omit=dev` → **0 vulnerabilities**.

### Removed during M01.5

| Package                          | Why                                                        |
| -------------------------------- | ---------------------------------------------------------- |
| `next-themes`                    | Unreferenced. Also invites a theme switcher the UI guidelines forbid. |
| `@tanstack/react-query-devtools` | Installed, never wired up.                                 |

### Flagged unused but required

`knip` reports `drizzle-orm` and `postgres` as unused dependencies. This is a
false positive: both are imported by `lib/drizzle/client.ts`, which knip
considers unreachable because no repository imports it yet. **Do not remove
them** — they are the ORM and driver adopted in ADR-001.

---

## 7b. Development Dependencies

| Package                       | Purpose                        |
| ----------------------------- | ------------------------------ |
| `typescript` · `@types/*`     | types                          |
| `eslint` · `eslint-config-next` · `eslint-config-prettier` · `typescript-eslint` | linting and architecture rules |
| `prettier` · `prettier-plugin-tailwindcss` | formatting        |
| `husky` · `lint-staged`       | pre-commit gate                |
| `drizzle-kit`                 | migrations                     |
| `dotenv`                      | loads `.env.local` for drizzle-kit |
| `tailwindcss` · `@tailwindcss/postcss` · `tw-animate-css` | styling |

`drizzle-kit@0.31.10` depends on the deprecated `@esbuild-kit/esm-loader`,
carrying 4 moderate dev-only advisories. No upstream fix exists; `npm audit fix
--force` would downgrade drizzle-kit to 0.18.1. Production audit is clean.

---

## 8. Boot Sequence

```
next start
   │
   ▼
instrumentation.ts register()
   │   NEXT_RUNTIME === "nodejs" ?
   │      └── import config/env.server  → Zod → THROW if DATABASE_URL invalid
   │                                       server refuses to start
   ▼
per request
   │
   ▼
proxy.ts
   │   imports lib/supabase/middleware → config/env
   │                                      → Zod → THROW if public env invalid
   ▼
route
```

Both halves of the environment are validated before anything can serve traffic.
Verified empirically in M01.5: blanking `NEXT_PUBLIC_SUPABASE_URL` fails the
build, and a malformed `DATABASE_URL` refuses server start.

**Known gap:** `next build` does not run `register()`, so a malformed
`DATABASE_URL` passes CI and fails at deploy time instead. Public env is caught
at build; server env is caught at boot.
