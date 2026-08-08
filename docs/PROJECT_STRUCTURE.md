# Project Structure

Version: 1.0
Milestone: M01.5
Generated: 2026-08-08

Describes the foundation as it actually exists. Every path below was read from
disk, not planned.

Authority: this document **describes**, it does not decide. `.ai/02_ARCHITECTURE.md`
and the ADRs decide. If this file disagrees with them, they win and this file is
wrong.

---

## 1. Complete Folder Tree

59 source files.

```
Yasser NF CRM/
├── .ai/                                  Source of truth. Not code.
│   ├── 01_MASTER_RULES.md
│   ├── 02_ARCHITECTURE.md                v1.2
│   ├── 03_DATABASE.md                    EMPTY — blocks database work
│   ├── 04_UI_GUIDELINES.md
│   ├── 05_DEVELOPMENT_WORKFLOW.md
│   ├── CURRENT_MILESTONE.md
│   └── adr/
│       ├── ADR-001-Technology-Decisions.md
│       ├── ADR-002-Foundation-Decisions.md
│       ├── ADR-003-Layering-And-Error-Model.md
│       └── ADR-004-Nextjs-16-Adoption.md
│
├── docs/
│   ├── PROJECT_STRUCTURE.md              This file
│   └── DEPENDENCY_GRAPH.md
│
├── drizzle/                              Migration output. Empty — no tables.
│
├── src/
│   ├── instrumentation.ts                Boot hook. Validates server env.
│   ├── proxy.ts                          Route protection at the edge.
│   │
│   ├── app/                              Routes and composition only.
│   │   ├── layout.tsx                     Root: fonts, metadata, providers.
│   │   ├── globals.css                    Design tokens. Visual source of truth.
│   │   ├── error.tsx                      Route error boundary.
│   │   ├── not-found.tsx                  404.
│   │   ├── (auth)/
│   │   │   └── login/page.tsx              Public. Composes LoginForm.
│   │   └── (app)/
│   │       ├── layout.tsx                  Auth gate + AppShell.
│   │       └── dashboard/page.tsx           Placeholder.
│   │
│   ├── modules/                          Business features.
│   │   └── auth/
│   │       ├── index.ts                    PUBLIC API. Only entry point.
│   │       ├── components/login-form.tsx
│   │       ├── hooks/use-login.ts
│   │       ├── hooks/use-logout.ts
│   │       ├── services/auth.service.ts    Returns Result. No UI.
│   │       └── validation/login.schema.ts
│   │
│   ├── shared/                           Reusable UI. No business logic.
│   │   ├── ui/                             9 shadcn primitives.
│   │   │   ├── avatar.tsx      button.tsx     card.tsx
│   │   │   ├── dropdown-menu.tsx  input.tsx   label.tsx
│   │   │   └── separator.tsx   skeleton.tsx   sonner.tsx
│   │   ├── layouts/
│   │   │   ├── app-shell.tsx               Composes the three below.
│   │   │   ├── sidebar.tsx                 Desktop, collapsible.
│   │   │   ├── topbar.tsx                  Search, bell, Quick Prepare, profile.
│   │   │   └── mobile-navigation.tsx       Bottom nav under lg.
│   │   ├── forms/form-field.tsx            Label + input + validation.
│   │   └── feedback/
│   │       ├── empty-state.tsx
│   │       └── error-state.tsx
│   │
│   ├── lib/                              Infrastructure.
│   │   ├── errors/                         AppError hierarchy.
│   │   │   ├── app-error.ts                 8 classes + 2 guards.
│   │   │   └── index.ts
│   │   ├── database/                       DATABASE ADAPTER.
│   │   │   ├── adapter.ts                   Only sanctioned Drizzle importer.
│   │   │   └── index.ts
│   │   ├── drizzle/
│   │   │   ├── client.ts                    Connection. Server-only.
│   │   │   └── schema/index.ts              EMPTY. Zero tables.
│   │   ├── supabase/
│   │   │   ├── client.ts                    Browser.
│   │   │   ├── server.ts                    RSC / actions. Server-only.
│   │   │   └── middleware.ts                Session refresh for proxy.
│   │   ├── auth/
│   │   │   ├── app-user.ts                  AppUser + mapper. Client-safe.
│   │   │   ├── session.ts                   getCurrentUser. Server-only.
│   │   │   └── index.ts                     Client-safe exports ONLY.
│   │   └── logger/index.ts
│   │
│   ├── config/
│   │   ├── env.ts                          Public env. Zod. Throws.
│   │   ├── env.server.ts                   Secrets. server-only. Throws.
│   │   ├── constants.ts                    ROUTES, pagination, storage keys.
│   │   ├── navigation.ts                   The 10 sidebar items.
│   │   ├── roles.ts                        Roles + permissions. Types only.
│   │   └── theme.ts                        Motion, spacing, radius constants.
│   │
│   ├── providers/
│   │   ├── index.tsx                       AppProviders composition.
│   │   ├── theme-provider.tsx              Dark + MotionConfig.
│   │   ├── query-provider.tsx              TanStack defaults + retry policy.
│   │   └── auth-provider.tsx               Session context.
│   │
│   ├── hooks/use-sidebar-store.ts          Zustand, persisted.
│   ├── types/
│   │   ├── result.ts                       Success / Failure / Result.
│   │   └── tanstack-query.d.ts             Registers AppError as TError.
│   └── utils/
│       ├── cn.ts                           Tailwind class merge.
│       └── result.ts                       ok, fail, unwrap, guards.
│
├── .env.example                          Committed. Placeholders only.
├── .env.local                            NEVER committed.
├── .gitattributes                        eol=lf. Keeps format:check honest.
├── .husky/pre-commit                     npx lint-staged
├── components.json                       shadcn aliases → shared/ui, utils/cn.
├── drizzle.config.ts                     Loads .env.local explicitly.
├── eslint.config.mjs                     Architecture rules live here.
└── next.config.ts                        agentRules: false.
```

---

## 2. Module Tree

One module exists. It is the reference shape for every future module.

```
modules/auth/
├── index.ts              ← the only thing outside may import
├── components/           React. Renders, decides nothing.
├── hooks/                Result → TanStack Query boundary.
├── services/             Business logic. Returns Result.
├── validation/           Zod schemas.
└── (repositories/)       Not present. No tables yet.
```

A module may also own `types/` and `utils/`. The auth module needs neither.

### Future modules

Per `.ai/02_ARCHITECTURE.md`, these arrive with their own milestones and are
**not** scaffolded: accounts, customers, orders, profiles, quick-prepare,
problems, search, reports, backup, users, dashboard.

Creating empty folders for them now would be scaffolding for excluded features.

---

## 3. Public APIs

### `modules/auth/index.ts`

| Export        | Kind      | Consumed outside the module?  |
| ------------- | --------- | ----------------------------- |
| `LoginForm`   | component | Yes — `(auth)/login/page.tsx` |
| `useLogout`   | hook      | Yes — `layouts/topbar.tsx`    |
| `useLogin`    | hook      | No                            |
| `authService` | service   | No                            |
| `loginSchema` | schema    | No                            |
| `LoginInput`  | type      | No                            |

The last four are exported but unconsumed. ADR-003 states that adding an export
is a deliberate architectural act; four of six exports currently widen the public
surface without a caller. See the health check report.

Never exported: repositories. That is a permanent rule.

### `lib/` public surfaces

| Barrel             | Exports                                            | Notes                                      |
| ------------------ | -------------------------------------------------- | ------------------------------------------ |
| `lib/errors`       | 8 error classes, `isAppError`, `toAppError`, types | Import site for all error handling         |
| `lib/database`     | `databaseAdapter`, executor types                  | The only door to the database              |
| `lib/auth`         | `AppUser`, `toAppUser`                             | **Client-safe only.** `session.ts` excluded |

`lib/auth/index.ts` deliberately omits `session.ts`. That module imports
`server-only`, so barrelling it would break the build for any client component
that merely wanted the `AppUser` type. Server code imports
`@/lib/auth/session` directly.

---

## 4. Shared Components

| Component      | Client? | Purpose                                             |
| -------------- | ------- | --------------------------------------------------- |
| `AppShell`     | server  | Sidebar + Topbar + content + MobileNavigation        |
| `Sidebar`      | client  | Reads Zustand collapse state, `usePathname`          |
| `Topbar`       | client  | `useAuth`, `useLogout`, Ctrl+K listener              |
| `MobileNavigation` | client | Bottom nav, 44px targets                         |
| `FormField`    | client  | Label, input, error, hint, trailing slot            |
| `EmptyState`   | server  | Icon, title, description, action                    |
| `ErrorState`   | client  | Renders `AppError.userMessage` only                 |

`AppShell` is a Server Component that composes client children. That keeps the
shell out of the client bundle while its interactive parts stay interactive.

---

## 5. Providers

Nesting order, outermost first. Order is not arbitrary.

```
ThemeProvider          Dark class + MotionConfig. Outermost so every
  │                    animation inside inherits the 200ms default and
  │                    the user's reduced-motion preference.
  └── QueryProvider    QueryClient created in useState, never at module
        │              scope — a module-scoped client would be shared
        │              across server requests and leak cached data.
        └── AuthProvider   Session context. Seeded from the server so the
              │            first paint knows who is signed in.
              ├── {children}
              └── Toaster      Inside AuthProvider so any layer can toast.
```

`AppProviders` receives `initialUser` from `app/layout.tsx`, which resolves it
server-side via `getCurrentUser()`.

---

## 6. Services

| Service       | Module | Returns              | Throws?                     |
| ------------- | ------ | -------------------- | --------------------------- |
| `authService` | auth   | `Result<AppUser>` / `VoidResult` | Never, for expected outcomes |

`authService.signIn` revalidates its input with Zod even though the form already
did. `.ai/02_ARCHITECTURE.md` requires validating twice and never trusting
frontend validation.

It also refuses to distinguish "no such account" from "wrong password" — both
produce identical wording, because differentiating them hands an attacker a way
to enumerate valid email addresses.

---

## 7. Repositories

**None exist.**

`.ai/03_DATABASE.md` is empty, so there are no tables to read or write. Writing a
repository now would require inventing the data model, which
`01_MASTER_RULES.md` forbids.

When they arrive, each lives at `modules/<feature>/repositories/`, and ESLint
already enforces the two rules that govern them:

- A repository may not import Drizzle.
- A repository may not import another module.

Both rules are live and tested — deliberate violations were confirmed to fail
lint during M01.

---

## 8. Database Adapter

`lib/database/adapter.ts` — the layer ADR-003 inserted between repositories and
Drizzle.

**Surface**

| Function                     | Returns             |
| ---------------------------- | ------------------- |
| `databaseAdapter.query`      | `Promise<Result<T>>` |
| `databaseAdapter.transaction`| `Promise<Result<T>>` |

**Why it exists.** It is the single place in the codebase permitted to import
Drizzle. That makes it the single place a PostgreSQL error can enter the system —
and it cannot leave without becoming an `AppError`. "Never expose technical
errors to users" therefore holds by construction rather than by discipline.

**Error translation**

| SQLSTATE | Meaning                | Becomes         |
| -------- | ---------------------- | --------------- |
| 23505    | unique_violation       | `ConflictError` |
| 23503    | foreign_key_violation  | `ConflictError` |
| 23502    | not_null_violation     | `DatabaseError` |
| 23514    | check_violation        | `DatabaseError` |
| other    | —                      | `DatabaseError` |

The driver's original message is preserved in `cause` for logs and never shown.
A constraint name tells a user nothing and leaks schema shape.

**Transactions.** The callback works in exceptions rather than Results, because
throwing is how the driver signals rollback. The Result boundary is restored on
the way out.

---

## 9. Data Flow

### Read path (once repositories exist)

```
┌──────────────────────────────────────────────────────────────┐
│ Component            "show me the accounts"                  │
│   useQuery(...)                                              │
└───────────────────────────┬──────────────────────────────────┘
                            │  hook calls service, unwraps Result
┌───────────────────────────▼──────────────────────────────────┐
│ Service              decides. authorization, rules, ordering │
│   Result<Account[]>                                          │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Repository           describes WHAT data is needed           │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Database Adapter     decides HOW. translates errors.         │
│                      ◄── only Drizzle importer ──►           │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Drizzle → PostgreSQL                                         │
└──────────────────────────────────────────────────────────────┘
```

### Result crossing into TanStack Query

The one place the two error models meet:

```
service returns Failure<AppError>
        │
        ▼
hook:  unwrap(result)  ──── throws the AppError ────┐
        │                                            │
        ▼                                            ▼
   queryFn rejects                        TanStack sees a rejection
        │                                            │
        ▼                                            ▼
   retry policy inspects the AppError        isError / error populated
   (terminal? don't retry)                            │
                                                      ▼
                                    component renders error.userMessage
```

Components never see a `Result`. Services never throw for expected outcomes.
Both statements hold because the conversion happens in exactly one function,
`unwrap`, called only in hooks.

### Authentication flow

```
Request
   │
   ▼
proxy.ts ─── updateSupabaseSession()
   │              │
   │              ├── credentials missing? → { user: null }, no network call
   │              └── else getUser() (revalidates with Supabase, not the cookie)
   │
   ├── path "/"                → redirect dashboard or login
   ├── guest + private path    → redirect /login?next=<path>
   ├── signed in + /login      → redirect /dashboard
   └── otherwise               → continue, carrying refreshed cookies
   │
   ▼
app/layout.tsx ── getCurrentUser() ──► AppProviders(initialUser)
   │                    │
   │                    └── React cache(): 3 callers, 1 network round trip
   ▼
(app)/layout.tsx ── getCurrentUser() again → redirect if null
   │                (second check: middleware can be bypassed by a matcher change)
   ▼
Page
```

Redirects rebuild the response and copy cookies across. A bare redirect would
discard a rotated session token and sign the user out on the next request.

---

## 10. How The Layers Communicate

| From        | To          | Mechanism                     | Forbidden                          |
| ----------- | ----------- | ----------------------------- | ---------------------------------- |
| `app/`      | module      | `@/modules/<feature>` barrel  | Deep import; business logic in page |
| Component   | Service     | via a hook                    | Calling a repository or the adapter |
| Hook        | Service     | direct call, then `unwrap`    | Unwrapping in a component          |
| Service     | Repository  | direct call, same module      | Reaching another module's repo      |
| Repository  | Adapter     | `@/lib/database`              | Importing Drizzle                   |
| Adapter     | Drizzle     | `@/lib/drizzle/client`        | Business logic                       |
| Module      | Module      | exported services only        | Importing internal files            |
| Anything    | `shared/`   | direct import                 | Business logic inside `shared/`      |

Rows 1, 5 and 6 are enforced by ESLint. The rest are enforced by review.

### Dependency direction

`modules` may depend on `shared`, `lib`, `config`, `types`, `utils`.
Nothing in `shared`, `lib`, `config`, `utils` may depend on a module.

Verified: `madge` reports **no circular dependencies** across all source files.

---

## 11. Known Structural Gaps

Honest list, as of M01.5.

| Gap                                    | Why                                        |
| -------------------------------------- | ------------------------------------------ |
| No repositories                        | `03_DATABASE.md` is empty                  |
| Drizzle schema empty                   | Same                                       |
| Database Adapter has no caller          | Same. Built ahead deliberately.            |
| No role storage                        | ADR-003 defers it                          |
| `AppUser` has no `role` field          | Same. Inventing one would be guessing.     |
| 4 of 6 auth exports unconsumed          | See health check                           |
