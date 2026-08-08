# ADR-003
# Layering, Module Boundaries and Error Model

Status: ACCEPTED

Date: 2026-08-07

Owner: Yasser Saidi

Amends: ADR-001, 02_ARCHITECTURE.md v1.2

---

# Context

ADR-001 defined the data access path as:

Service

↓

Repository

↓

Drizzle

↓

PostgreSQL

That path left three questions unanswered.

Where do raw database errors stop.

How does a caller know an operation failed.

What prevents one module from reaching into another.

The project owner answered all three by adding five architectural rules.

This ADR records them and the decisions required to apply them.

---

# Rule 1

## Decision

Services never access the database.

A Database Adapter layer is inserted between Repository and Drizzle.

React Component

↓

Feature Service

↓

Repository

↓

Database Adapter

↓

Drizzle

↓

PostgreSQL

## Why

Only one file in the project may import Drizzle.

That single import point becomes the place where PostgreSQL errors are translated into AppError instances.

01_MASTER_RULES.md forbids exposing technical errors to users.

Without a chokepoint that rule depends on discipline.

With a chokepoint it depends on structure.

## Consequence

Replacing the ORM touches one directory.

lib/database/

Repositories describe WHAT.

The Adapter decides HOW.

A repository that imports Drizzle is an architecture violation, not a style preference.

---

# Rule 2

## Decision

Every module exposes exactly one public API.

modules/<feature>/index.ts

No module may import another module's internal files.

## Why

Without a barrel, every internal file is a potential dependency.

Coupling then grows silently and is discovered only during refactoring.

A single entry point makes every cross-module dependency visible in one file.

## Enforcement

ESLint no-restricted-imports blocks patterns matching:

@/modules/*/*

The rule is mechanical.

A convention that is not enforced by tooling is a convention that will be broken.

## Consequence

Repositories are never exported from index.ts.

Exporting is a deliberate architectural act.

---

# Rule 3

## Decision

Services return Result objects.

Success<T>

Failure<AppError>

null is forbidden as a business return value.

undefined is forbidden as a business return value.

## Why

A thrown exception is invisible to the type system.

A Result is part of the signature.

The compiler then forces every caller to handle failure.

Absence becomes explicit.

A customer that does not exist is not an exception.

It is a Failure carrying NotFoundError.

## Location

Type

types/result.ts

Constructors

utils/result.ts

## Why this location

02_ARCHITECTURE.md defines types/ as global types only.

02_ARCHITECTURE.md defines utils/ as pure helper functions.

The Result type is a global type.

The ok and fail constructors are pure functions.

Both placements follow the locked architecture rather than convenience.

## Scope

Exceptions remain acceptable for two cases only.

Programmer errors.

Unrecoverable infrastructure failure.

Never for expected business outcomes.

---

# Result At The Query Boundary

## Context

This decision was required to apply Rule 3 and was not specified by the project owner.

TanStack Query signals failure through rejected promises.

Services signal failure through Failure objects.

Both cannot be ignored.

## Decision

Services return Result.

Hooks unwrap Result.

queryFn and mutationFn throw the AppError contained in a Failure.

Components consume ordinary TanStack Query state.

isLoading

isError

error

## Why

Business logic stays exception-free and testable without try/catch.

TanStack Query retry, caching and error boundaries continue to function as designed.

Unwrapping happens in exactly one place per hook.

## Rejected alternative

Passing Result objects into components.

Rejected because every component would reimplement error branching, TanStack Query would never observe a failure, retry would silently stop working, and error boundaries would never fire.

## Consequence

Never unwrap a Result inside a component.

---

# Rule 4

## Decision

Every application error inherits from AppError.

Location

lib/errors/

## Hierarchy

AppError

ValidationError

NotFoundError

ConflictError

UnauthorizedError

ForbiddenError

DatabaseError

ExternalServiceError

## Carried data

code

user-facing message

severity

operational flag

optional cause

## Why

The user-facing message belongs to the error, not to the screen.

The same failure must read identically wherever it surfaces.

An error defined once cannot drift between pages.

## Rules

Never throw a raw Error.

Never build an error message inside a component.

Never expose code, cause or stack trace to the user.

## Why classes rather than plain objects

Failure carries an AppError instance.

instanceof narrowing keeps handling type safe.

The class also carries behaviour, which a plain type cannot.

---

# Rule 5

## Decision

Every feature must be removable.

## Test

Deleting modules/<feature>/ must break only that feature.

If an unrelated module breaks, coupling exists and must be removed.

## Why

Removability is the only honest measure of coupling.

Architecture diagrams describe intent.

Deletion reveals truth.

## Consequence

Shared behaviour belongs in lib, shared, utils or config.

Never in a sibling module.

---

# Impact On Milestone M01

These rules add foundation work to M01.

types/result.ts

utils/result.ts

lib/errors/

lib/database/

modules/auth/index.ts

ESLint no-restricted-imports configuration

The auth module becomes the reference implementation.

Every future module copies its shape.

No repository or adapter query is written in M01 because 03_DATABASE.md is still empty and no tables exist.

The adapter is created with connection handling and error translation only.

---

# Final Decision

These rules are adopted and become part of the project architecture.

Changing any of them requires a new ADR and approval from the project owner.

---

END OF ADR-003
