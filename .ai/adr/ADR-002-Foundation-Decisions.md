# ADR-002
# Foundation Decisions

Status: ACCEPTED

Date: 2026-08-07

Owner: Yasser Saidi

Supersedes: Nothing

Amends: ADR-001

---

# Context

ADR-001 adopted the project technologies but left several implementation details unspecified.

Milestone M01 cannot be built without resolving them.

This ADR records those decisions so no future contributor has to guess.

---

# Tailwind Version

## Decision

Tailwind CSS v4

## Why

Current default for Next.js 15.

Design tokens are authored CSS-first using @theme.

Faster engine.

Fully supported by shadcn/ui.

## Consequence

There is no tailwind.config.ts.

All design tokens live in src/styles.

Never reintroduce a JavaScript Tailwind config.

---

# Supabase SSR Package

## Decision

@supabase/ssr

## Why

Cookie-based session handling in the Next.js App Router is impossible without it.

Middleware cannot refresh sessions without it.

This implements the Supabase Auth decision from ADR-001.

It replaces no technology.

---

# Type-Aware Linting

## Decision

typescript-eslint

no-explicit-any enforced as an error

## Why

01_MASTER_RULES.md forbids "any".

The default Next.js ESLint configuration cannot enforce that rule.

A rule that is not mechanically enforced is not a rule.

---

# shadcn/ui Paths

## Decision

Components

@/shared/ui

Class merge helper

@/utils/cn

## Why

The shadcn defaults are components/ui and lib/utils.ts.

Both violate 02_ARCHITECTURE.md.

lib/ is reserved for infrastructure.

Supabase

Drizzle

Auth

Logger

Clipboard

Phone

The cn helper is a pure function with no infrastructure dependency.

utils/ is defined as pure helper functions.

Therefore cn belongs in utils/.

## Consequence

components.json must declare these aliases explicitly.

Never accept the shadcn default paths.

---

# Authorization Enforcement

## Context

ADR-001 lists Row Level Security as a reason for choosing Supabase.

However the mandated data path is:

Service

↓

Repository

↓

Drizzle

↓

PostgreSQL

Drizzle connects through a privileged Postgres role.

That path bypasses Row Level Security entirely.

Both cannot be the primary enforcement mechanism.

## Decision

Primary enforcement

Server-side authorization inside the service layer.

Defense in depth

Row Level Security protects any direct Supabase client path.

Storage

Realtime

## Why

01_MASTER_RULES.md requires never trusting the frontend.

02_ARCHITECTURE.md requires validating input twice.

Server-side service authorization satisfies both.

Row Level Security remains valuable but is not the only guard.

## Consequence

Every repository method that reads or writes tenant data must be called by a service that has already validated the session and the role.

A repository must never be called directly from a route handler.

---

# Role Storage

## Context

03_DATABASE.md is empty.

The user and role tables are undefined.

## Decision

Milestone M01 defines roles as types only.

config/roles.ts

Super Admin

Worker

No role is persisted in M01.

Route protection in M01 is authenticated versus guest only.

## Why

Persisting a role now would pre-commit a schema decision that 03_DATABASE.md may contradict.

02_ARCHITECTURE.md explicitly names config/roles.ts, so the file is expected.

CURRENT_MILESTONE.md task 23 requires only guest and authenticated redirection.

## Consequence

Role-based access control is deferred until 03_DATABASE.md is written.

M01 ships with zero database tables.

---

# Package Manager Confirmation

## Decision

npm

Confirmed from ADR-001.

No pnpm.

No yarn.

No bun.

---

# Animation Package

## Decision

framer-motion

## Why

ADR-001 names Framer Motion.

The successor package is published as motion.

framer-motion remains maintained and matches the ADR literally.

Migrating to motion would require a new ADR.

---

# Git Strategy Initialization

## Decision

The repository is initialized during M01.

main

develop

feature/foundation

## Why

05_DEVELOPMENT_WORKFLOW.md mandates this branch strategy.

The strategy cannot exist without an initialized repository.

---

# Final Decision

These decisions are adopted.

Changing any of them requires a new ADR and approval from the project owner.

---

END OF ADR-002
