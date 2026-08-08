# Project Health Check

Version: 1.0
Milestone: M01.5
Generated: 2026-08-08
Commit: post-`5ca06ba`

Tooling: `knip` (unused files/exports/deps), `madge` (circular deps), ripgrep
(TODOs, `any`, assertions), `tsc`, `eslint`, `prettier`, `npm audit`.

`knip` and `madge` were run via `npx` and **not** added as dependencies. A
permanent devDependency for an occasional audit would itself be an unused
package.

Nothing was removed except where marked **REMOVED**. Everything else is reported
for the project owner to decide, per the M01.5 brief.

---

## Summary

| Category              | Count | Severity |
| --------------------- | ----- | -------- |
| Circular dependencies | 0     | —        |
| TODO / FIXME / HACK   | 0     | —        |
| `any` usage           | 0     | —        |
| Lint suppressions     | 0     | —        |
| Unused packages       | 2 → **removed** | — |
| Unused files          | 6     | Low      |
| Unused exports        | 37    | Low      |
| Unused exported types | 6     | Low      |
| Duplicate code        | 2 sites | Low    |
| Weak typing           | 4 assertions, all justified | Low |
| Missing documentation | 10 files | Low   |
| Dev-only advisories   | 4 moderate | Medium |

No high-severity findings.

---

## 1. Circular Dependencies

**None.** `madge --circular` across 59 files.

```
✔ No circular dependency found!
```

The `lib/errors` → `types/result` → `utils/result` chain is strictly one
directional, and `lib/errors` imports nothing internal at all, which is what
keeps it acyclic by construction.

---

## 2. TODO Comments

**None.** Zero matches for `TODO`, `FIXME`, `HACK`, `XXX`.

Also zero `@ts-ignore`, `@ts-expect-error`, and `eslint-disable`. No rule is
suppressed anywhere in the codebase.

---

## 3. `any` Usage

**None.** The four ripgrep hits for `\bany\b` are all the English word "any"
inside prose comments.

Enforced by `@typescript-eslint/no-explicit-any: error`, verified during M01 with
a deliberate violation that failed lint.

---

## 4. Weak Typing

Four type assertions. All at boundaries where TypeScript genuinely cannot infer.

| Location                       | Assertion                        | Verdict |
| ------------------------------ | -------------------------------- | ------- |
| `lib/drizzle/client.ts:22`     | `globalThis as unknown as {...}` | Justified — the standard Next.js HMR connection-cache idiom. Without it, every file save opens a new pool until Postgres refuses connections. |
| `lib/database/adapter.ts:48`   | `(value as { code: unknown })`   | Justified — inside `isDriverError`, narrowing `unknown`. This is what a type guard is for. |
| `shared/ui/sonner.tsx:46`      | `as React.CSSProperties`         | Justified — React's CSS types do not admit custom properties. |
| `config/navigation.ts:87`      | `as readonly string[]`           | **Weakest of the four.** Widens a readonly tuple so `.includes` accepts a general string. A `Set<string>` would avoid the assertion and read better. Cosmetic. |

`tsconfig.json` runs `strict` plus `noUncheckedIndexedAccess`,
`noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
`noUnusedLocals`, `noUnusedParameters`.

**Not enabled:** `exactOptionalPropertyTypes`. It conflicts with React prop
spreading and Radix types to the point that satisfying it would require
escape hatches — a net loss against "no `any`". Deliberate, and flagged rather
than hidden.

---

## 5. Unused Packages

### REMOVED

| Package                          | Reason |
| -------------------------------- | ------ |
| `next-themes`                    | Zero imports. Installed by the shadcn CLI for its `sonner.tsx`, which was rewritten to drop it. Beyond being unused, it is the library for exactly the theme switching `04_UI_GUIDELINES.md` forbids — leaving it installed invites reintroduction. |
| `@tanstack/react-query-devtools` | Zero imports. Installed during M01 and never wired into `QueryProvider`. |

Both were confirmed unreferenced across all source, config and CSS before
removal. `npm run verify` passes after removal.

**Recommendation:** re-add the devtools in M02, when real queries exist and it
earns its place.

### FALSE POSITIVES — do not remove

`knip` reports these as unused dependencies:

| Package       | Actually imported by      |
| ------------- | ------------------------- |
| `drizzle-orm` | `lib/drizzle/client.ts`   |
| `postgres`    | `lib/drizzle/client.ts`   |

`knip` treats `lib/drizzle/client.ts` as unreachable because no repository
imports it yet, so everything downstream of it looks unused. Both packages are
the ORM and driver adopted in ADR-001.

This false positive will disappear the moment the first repository exists.

---

## 6. Unused Files

Six files, none of them accidental. Grouped by why they exist.

### Foundation built ahead of use — KEEP

| File                        | Justification |
| --------------------------- | ------------- |
| `lib/database/adapter.ts`   | The layer ADR-003 mandates. Has no caller because there are no repositories, because `03_DATABASE.md` is empty. |
| `lib/database/index.ts`     | Its barrel. |
| `lib/drizzle/client.ts`     | Same chain. |

Removing these would mean deleting the architecture ADR-003 was written to
establish, then rebuilding it in M02. They are deliberately early, not dead.

### Design system obligation — KEEP

| File                            | Justification |
| ------------------------------- | ------------- |
| `shared/feedback/empty-state.tsx` | `04_UI_GUIDELINES.md`: "Every module must define an Empty State." Unused only because no list page exists yet. Its absence would make skipping empty states the path of least resistance. |
| `shared/ui/card.tsx`            | `04_UI_GUIDELINES.md`: "Cards are preferred over large tables whenever possible." Certain to be used by the first data screen. |

### Genuinely spare — OWNER'S CALL

| File                       | Note |
| -------------------------- | ---- |
| `shared/ui/separator.tsx`  | Nothing imports it. `dropdown-menu.tsx` ships its own `DropdownMenuSeparator`, so the standalone primitive has no current or obvious future consumer. Re-addable in one command: `npx shadcn@latest add separator`. |

This is the only file where "delete it" is a defensible position. Left in place
because the brief says not to remove anything that is not unquestionably safe,
and a shadcn primitive is cheap to keep and cheap to restore.

---

## 7. Unused Exports

37 exports and 6 exported types are unconsumed. Four distinct causes, only one of
which is worth acting on.

### 7a. Public API wider than its consumers — WORTH ACTING ON

`modules/auth/index.ts` exports six things. Two are used.

| Export        | Consumed outside module? |
| ------------- | ------------------------ |
| `LoginForm`   | Yes                      |
| `useLogout`   | Yes                      |
| `useLogin`    | No                       |
| `authService` | No                       |
| `loginSchema` | No                       |
| `LoginInput`  | No                       |

ADR-003: *"Adding an export is a deliberate architectural act."* Four exports
currently widen the module's contract with nothing on the other side. Every one is
a promise the module must keep during future refactors.

**Recommendation:** narrow to `LoginForm` and `useLogout`. Re-export the others
when a caller appears.

**Not done here** because it is a judgement call about intended API surface —
`authService` in particular is plausibly meant for cross-module use in M02 — and
the brief forbids refactoring beyond verification.

### 7b. Chain false positives — IGNORE

Flagged only because `lib/database/adapter.ts` looks unreachable:
`ConflictError`, `DatabaseError`, `UnexpectedError` (and their barrel
re-exports). All three are genuinely used — the adapter constructs the first two,
`toAppError` constructs the third.

### 7c. Vendor surface — EXPECTED

19 of the 37 are shadcn re-exports: `AvatarImage`, `AvatarBadge`, `AvatarGroup`,
`AvatarGroupCount`, `buttonVariants`, and 9 `DropdownMenu*` sub-components.

This is inherent to the shadcn model — you own the file, so you get its whole
surface whether you use it or not. Trimming these would mean editing vendor code
and re-editing it after every `shadcn add`.

### 7d. Foundation API surface — KEEP

| Export | Note |
| ------ | ---- |
| `isSuccess`, `isFailure`, `unwrapOr`, `mapResult` | The Result API from ADR-003. Currently only `ok`, `fail` and `unwrap` have callers. An incomplete Result type invites hand-rolled alternatives. |
| `USER_ROLES`, `UserRole`, `roleHasPermission`, `ROLE_LABELS` | Role model deliberately deferred by ADR-003. |
| `SPACING_SCALE`, `RADIUS`, `TRANSITION`, `MIN_TOUCH_TARGET_PX`, `SpacingStep` | Design constraints as code. `SPACING_SCALE` and `MIN_TOUCH_TARGET_PX` document limits that `04_UI_GUIDELINES.md` states in prose. `TRANSITION` is the one with no near-term consumer — components use `DURATION`/`EASING` directly. |
| `PAGINATION`, `AppRoute` | Needed by the first paginated list. |
| `PLACEHOLDER_SUPABASE_URL`, `PLACEHOLDER_SUPABASE_ANON_KEY` | Used *inside* `env.ts` by `isSupabaseConfigured`. The `export` keyword is unnecessary and could be dropped. Trivial. |

---

## 8. Duplicate Code

Two sites. Both low severity.

### 8a. Repeated configuration guard — will become dead code

`isSupabaseConfigured()` is checked at five call sites:

```
modules/auth/services/auth.service.ts:88    signIn
modules/auth/services/auth.service.ts:132   signOut
modules/auth/components/login-form.tsx:26   banner visibility
lib/auth/session.ts:31                      server session read
lib/supabase/middleware.ts:33               proxy short-circuit
```

Each guards a genuinely distinct entry point, so this is a cross-cutting
precondition rather than copy-paste. But it is worth naming what happens next:
**once real credentials are provisioned, four of these five branches become
permanently unreachable.** That is scheduled dead code.

**Recommendation:** revisit all five immediately after Supabase is provisioned.
The banner in `login-form.tsx` is the only one with lasting value (it explains a
genuine misconfiguration to a human); the other four exist to avoid pointless
network calls against a placeholder host.

### 8b. Alert markup

`modules/auth/components/login-form.tsx` builds two visually near-identical alert
blocks inline — one warning, one danger — each an icon plus a heading and body.
`shared/feedback/error-state.tsx` builds a third variation of the same idea.

Not urgent at three instances. If a fourth appears, extract a shared `Alert`
primitive (`npx shadcn@latest add alert` provides one) rather than adding another
inline block.

---

## 9. Missing Documentation

Ten files carry no doc comment.

| Files | Verdict |
| ----- | ------- |
| 8 × `shared/ui/*.tsx` (avatar, button, card, dropdown-menu, input, label, separator, skeleton) | **Acceptable.** Vendor code generated by the shadcn CLI. Adding headers guarantees a conflict on the next `shadcn add`. Note that `sonner.tsx` *is* documented — because it was deliberately modified, and the reasons needed recording. |
| `lib/errors/index.ts`, `lib/database/index.ts` | **Acceptable.** Pure re-export barrels with nothing to explain. Contrast `lib/auth/index.ts`, which *is* documented, because its omission of `session.ts` is load-bearing and non-obvious. |

Every service, hook, provider, config module and adapter has a header explaining
**why**, per `01_MASTER_RULES.md`.

---

## 10. Security Posture

| Check | Result |
| ----- | ------ |
| Secrets in git | None. `.env.local` ignored; only `.env.example` tracked, containing placeholders. |
| Production vulnerabilities | 0 (`npm audit --omit=dev`) |
| `server-only` guards | 5 modules |
| Service key in code | Never referenced anywhere |
| Technical errors reaching UI | None — verified in browser; only `AppError.userMessage` renders |
| Email enumeration | Prevented — "no such account" and "wrong password" produce identical wording |
| Open redirect | Prevented — `toSafeRedirect` rejects absolute and protocol-relative targets |

### Dev-only advisories — MEDIUM, accepted

4 moderate advisories, all from one chain:

```
drizzle-kit@0.31.10 → @esbuild-kit/esm-loader (deprecated) → esbuild ≤0.24.2
```

- The advisory (GHSA-67mh-4wv8-2f99) concerns esbuild's **dev server**. `drizzle-kit`
  uses esbuild to transpile `drizzle.config.ts` and never starts that server.
- `drizzle-kit@0.31.10` is the latest release and still carries the dependency.
  There is no version to upgrade to.
- `npm audit fix --force` "resolves" it by downgrading `drizzle-kit` to **0.18.1**,
  a breaking downgrade of the migration tool.
- A targeted `overrides` entry was attempted during M01 and did not take:
  `@esbuild-kit/core-utils` pins esbuild `^0.18`.

**Accepted.** `npm run audit:prod` is the gate that governs shipped code.
Re-evaluate whenever `drizzle-kit` releases.

---

## 11. Verification Gates

`npm run verify` runs five gates and stops at the first failure. Confirmed by
introducing a deliberate `any`: the run halted at lint and never reached build.

| Gate | Command | Status |
| ---- | ------- | ------ |
| Lint | `eslint --max-warnings=0` | PASS |
| Types | `tsc --noEmit` | PASS |
| Format | `prettier --check .` | PASS |
| Build | `next build` | PASS |
| Audit | `npm audit --omit=dev` | PASS, 0 vulnerabilities |

Exit code 0.
