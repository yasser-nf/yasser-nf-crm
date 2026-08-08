# Yasser NF CRM

Private internal Netflix subscription management system.

Not SaaS. Not a customer portal. An internal operating system.

---

## Source Of Truth

All architectural decisions live in [`.ai/`](.ai). Read them before changing anything.

Priority order, per `05_DEVELOPMENT_WORKFLOW.md`:

1. `01_MASTER_RULES.md`
2. `adr/` — Architecture Decision Records
3. `02_ARCHITECTURE.md`
4. `03_DATABASE.md`
5. `04_UI_GUIDELINES.md`
6. `CURRENT_MILESTONE.md`

If two documents conflict, stop and ask. Never guess.

---

## Stack

| Concern       | Choice                          | Record   |
| ------------- | ------------------------------- | -------- |
| Framework     | Next.js 16 (App Router)         | ADR-004  |
| Language      | TypeScript, strict              | ADR-001  |
| Styling       | Tailwind CSS v4                 | ADR-002  |
| Components    | shadcn/ui on Radix              | ADR-001  |
| Icons         | Lucide                          | ADR-001  |
| Animation     | Framer Motion                   | ADR-001  |
| Backend       | Supabase                        | ADR-001  |
| Database      | PostgreSQL                      | ADR-001  |
| ORM           | Drizzle                         | ADR-001  |
| Global state  | Zustand                         | ADR-001  |
| Server state  | TanStack Query                  | ADR-001  |
| Forms         | React Hook Form + Zod           | ADR-001  |
| Deployment    | Vercel                          | ADR-001  |

Changing any of these requires a new ADR and the project owner's approval.

---

## Getting Started

Requires Node.js 22 or later. Package manager is npm — not pnpm, yarn or bun.

```bash
npm install
cp .env.example .env.local
npm run dev
```

`.env.example` ships shape-valid placeholders so the project builds before a
Supabase project exists. Authentication is not mocked — it fails honestly until
real credentials are supplied, and the login page says so explicitly.

---

## Scripts

| Command               | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `npm run verify`      | **All gates below. Run before every commit.**  |
| `npm run dev`         | Development server                             |
| `npm run build`       | Production build                               |
| `npm run lint`        | ESLint, including architecture boundary rules  |
| `npm run typecheck`   | TypeScript with no emit                        |
| `npm run format`      | Prettier write                                 |
| `npm run format:check`| Prettier check without writing                 |
| `npm run audit:prod`  | Audit production dependencies only             |
| `npm run db:generate` | Generate a migration from the Drizzle schema   |
| `npm run db:migrate`  | Apply migrations                               |
| `npm run db:studio`   | Drizzle Studio                                 |

`npm run verify` runs lint → typecheck → format check → production build →
production audit, and stops at the first failure.

---

## Documentation

| Document | Contents |
| -------- | -------- |
| [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) | Folder tree, module tree, public APIs, layer communication, data flow |
| [docs/DEPENDENCY_GRAPH.md](docs/DEPENDENCY_GRAPH.md) | The six-layer chain, shared dependencies, providers, boot sequence |
| [docs/HEALTH_CHECK.md](docs/HEALTH_CHECK.md) | Dead code, duplication, unused exports, weak typing, security posture |

These describe the code. `.ai/` decides it. Where they disagree, `.ai/` wins.

---

## Architecture

Feature-based. Organised by business capability, never by file type.

```
src/
  app/          Routes, layouts, page composition. No business logic.
  modules/      Business features. Each owns one public index.ts.
  shared/       Reusable UI with no business logic.
  lib/          Infrastructure: supabase, drizzle, database, errors, auth, logger.
  config/       env, theme, navigation, roles, constants.
  providers/    Application providers.
  hooks/        Global hooks.
  types/        Global types.
  utils/        Pure helpers.
```

### Data flow

```
React Component → Feature Service → Repository → Database Adapter → Drizzle → PostgreSQL
```

Never skip a layer. Never invert one.

### Three rules that ESLint enforces

Architecture that relies on memory decays. These fail the build instead:

1. **Module boundaries.** Importing `@/modules/accounts/services/…` is an error.
   Import `@/modules/accounts`.
2. **Drizzle isolation.** Only `lib/database` may import Drizzle. Repositories
   describe what data is needed; the Adapter decides how to get it.
3. **No `any`.** Enforced as an error, not a warning.

### Errors and results

Services return `Result<T>` — `Success<T>` or `Failure<AppError>`. They do not
throw for expected outcomes, and never return `null` or `undefined` for a
business operation. A missing record is a `Failure` carrying `NotFoundError`.

Hooks unwrap the Result at the TanStack Query boundary so `queryFn` throws,
keeping retry, caching and error boundaries working. Components never see a
`Result`, and never render anything but `AppError.userMessage`.

See ADR-003.

---

## Conventions

- Dark theme only. There is no light theme and no switcher.
- Spacing comes from the documented scale. Never invent a value.
- Every page needs a loading, empty and error state.
- Absolute imports via `@/`. Never `../../../`.
- Commits: `feat(auth): add login page`. Never bare `fix` or `update`.
- Branches: `main` stable, `develop` current, `feature/*` one feature each.
