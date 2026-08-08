# Yasser NF CRM
# ARCHITECTURE

Version: 1.2
Status: LOCKED

---

# PURPOSE

This document defines the software architecture of Yasser NF CRM.

It specifies:

- Folder structure
- Responsibilities
- Module boundaries
- Data flow
- Dependency rules
- State management
- Backend interaction

No implementation may violate this architecture.

---

# ARCHITECTURE STYLE

Feature-Based Architecture

The project is organized by business features, not by file type.

Every business feature owns everything related to it.

Example

modules/
    accounts/
    customers/
    dashboard/
    search/

Never organize the project by:

components/

hooks/

pages/

services/

for the entire application.

Everything belongs to a feature whenever possible.

---

# APPLICATION LAYERS

The application follows five layers.

UI

↓

Feature Components

↓

Business Services

↓

Database/API

↓

Storage

Each layer has a single responsibility.

---

# DATA FLOW

The data flow is always:

User

↓

UI Component

↓

Service

↓

Supabase / Database

↓

Service

↓

UI

Never access the database directly from a component.

Never place SQL logic inside React components.

---

# ROOT STRUCTURE

src/

    app/

    modules/

    shared/

    lib/

    hooks/

    providers/

    styles/

    types/

    utils/

    config/

---

# APP DIRECTORY

Contains:

Layouts

Routes

Providers

Page composition

Nothing else.

Business logic is forbidden.

---

# MODULES

Every feature has its own module.

Example

modules/

    accounts/

        index.ts

        components/

        hooks/

        services/

        repositories/

        types/

        utils/

        validation/

        pages/

Each module is isolated.

index.ts is the only public surface.

Everything else is internal.

---

# SHARED

Contains reusable application-wide components.

Example

shared/

    ui/

    icons/

    layouts/

    modals/

    forms/

    tables/

    cards/

Shared components contain no business logic.

---

# LIB

Contains infrastructure.

Example

lib/

    supabase/

    drizzle/

    database/

    errors/

    auth/

    logger/

    clipboard/

    phone/

Distinction

lib/drizzle/

Drizzle client, schema and migration configuration.

lib/database/

The Database Adapter that wraps Drizzle.

Repositories import lib/database.

Repositories never import lib/drizzle.

---

# CONFIG

Contains project configuration.

config/

theme.ts

navigation.ts

roles.ts

constants.ts

---

# PROVIDERS

Contains application providers.

providers/

theme-provider.tsx

query-provider.tsx

auth-provider.tsx

---

# TYPES

Global types only.

Feature types belong inside the feature.

---

# UTILS

Pure helper functions.

No business logic.

No API calls.

---

# STATE MANAGEMENT

Global State

Use Zustand only.

Server State

Use TanStack Query.

Forms

React Hook Form.

Validation

Zod.

Never duplicate state.

---

# DATABASE ACCESS

Database access is centralized.

Services never touch the database.

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

Never skip layers.

Never invert layers.

---

# DATABASE ADAPTER

The Database Adapter is the only code in the project permitted to import Drizzle.

Location

lib/database/

Responsibilities

Own the connection.

Execute queries.

Manage transactions.

Translate database errors into typed AppError instances.

Forbidden

Business logic.

Feature knowledge.

Table-specific query building.

Why this layer exists

Repositories describe WHAT data is needed.

The Adapter decides HOW it is retrieved.

Raw PostgreSQL errors die at this boundary and never travel upward.

Replacing the ORM becomes an isolated change.

---

# REPOSITORIES

A Repository belongs to its module.

Location

modules/<feature>/repositories/

Responsibilities

Describe data operations for one entity.

Map database rows to domain types.

Forbidden

Importing Drizzle.

Importing another module.

Business decisions.

Repositories are called only by services inside their own module.

---

# AUTHENTICATION

Supabase Auth.

Protected routes.

Role validation.

Session validation.

Never trust the frontend.

---

# ROUTES

The Sidebar defined in 04_UI_GUIDELINES.md is the canonical navigation.

This route list matches it exactly, in the same order.

Public

/login

Private

/dashboard

/accounts

/quick-prepare

/customers

/problems

/users

/reports

/backups

/logs

/settings

Navigation is declared once in config/navigation.ts.

Never hardcode navigation items inside components.

Worker cannot access protected admin routes.

---

# DESIGN SYSTEM

One design system.

One spacing scale.

One typography scale.

One color system.

No inline styling.

No duplicated styles.

---

# IMPORT RULES

Use absolute imports.

Example

@/modules/accounts

Never use long relative imports.

Bad

../../../../../

---

# SERVICES

Each feature owns its own services.

Example

accounts/

services/

account.service.ts

Only services communicate with the database.

---

# VALIDATION

Every input

must be validated.

Frontend

↓

Zod

Backend

↓

Validation again

Never trust frontend validation.

---

# FORMS

Every form uses:

React Hook Form

+

Zod

Never use uncontrolled business forms.

---

# TABLES

Every table supports:

Pagination

Sorting

Filtering

Loading

Empty State

Error State

---

# SEARCH

Search is global.

Every feature registers searchable fields.

Search Engine aggregates results.

---

# LOGGING

Every business action

creates:

Audit Log

Timeline Event

Optional Notification

---

# PHONE ENGINE

Responsible for:

Normalize Number

Generate WhatsApp Link

Duplicate Detection

Formatting

No feature should normalize phone numbers itself.

---

# CLIPBOARD ENGINE

Responsible for:

Copy Account

Copy Password

Copy Customer

Copy Profile

Standardized output.

---

# NOTIFICATION ENGINE

Responsible for:

System notifications

Success

Error

Warning

Realtime updates

---

# SMART STOCK ENGINE

Independent service.

Never embedded inside UI.

Calculates:

Health Score

Availability

Distribution

Priority

Returns best account.

---

# BACKUP ENGINE

Independent module.

Supports:

Hourly

Daily

Manual

Restore

Verification

---

# ERROR HANDLING

Errors flow:

Database

↓

Service

↓

Typed Error

↓

UI

Never expose raw database errors.

---

# RESPONSIBILITY RULES

Component

Displays.

Service

Decides.

Repository

Describes data operations.

Database Adapter

Executes.

Database

Stores.

Never mix responsibilities.

---

# DEPENDENCY RULES

Modules may depend on:

Shared

Lib

Types

Config

Modules may NOT depend on each other directly.

Communication happens through exported services only.

---

# MODULE PUBLIC API

Every module exposes exactly one public entry point.

modules/<feature>/index.ts

That file is the module contract.

Allowed

import { AccountService } from "@/modules/accounts"

Forbidden

import { AccountService } from "@/modules/accounts/services/account.service"

No module may import another module's internal files.

Internals are private.

If something is not exported from index.ts, it does not exist to the rest of the application.

Rule

Adding an export is a deliberate architectural act.

Never export a module's repositories.

Never export a module's internal types unless another module genuinely requires them.

Enforcement

ESLint no-restricted-imports blocks deep module paths.

The rule is mechanical, not advisory.

---

# RESULT PATTERN

Services never throw business exceptions.

Services return Result objects.

Success<T>

Failure<AppError>

Rules

Never return null for a business operation.

Never return undefined for a business operation.

Never throw to signal an expected business outcome.

Absence is a valid result and must be modelled explicitly.

Example

A customer that does not exist is not an exception.

It is a Failure carrying NotFoundError.

Exceptions remain acceptable only for programmer errors and unrecoverable infrastructure failures.

Location

Type

types/result.ts

Constructors

utils/result.ts

Why

Errors become part of the type signature.

The compiler forces every caller to handle failure.

Business logic becomes testable without try/catch.

---

# RESULT AT THE QUERY BOUNDARY

TanStack Query represents failure through rejected promises.

Services represent failure through Failure objects.

The two meet at the hook boundary.

Rule

Services return Result.

Hooks unwrap Result.

A Failure is thrown as its AppError inside queryFn and mutationFn.

Components consume normal TanStack Query state.

isLoading

isError

error

Why

Business logic stays exception-free and testable.

Retry, caching and error boundaries continue to work as designed.

The unwrap happens in exactly one place per hook.

Never unwrap a Result inside a component.

---

# ERROR HIERARCHY

Every application error inherits from AppError.

Location

lib/errors/

Base

AppError

Carries

code

user-facing message

severity

operational flag

optional cause

Categories

ValidationError

NotFoundError

ConflictError

UnauthorizedError

ForbiddenError

DatabaseError

ExternalServiceError

Rules

Never throw a raw Error.

Never construct an error message inside a component.

Never expose code, cause or stack traces to the user.

The user-facing message is defined at the error, not at the screen.

---

# REMOVABILITY

Every feature must be removable.

Test

Deleting modules/<feature>/ must break only that feature.

If deleting a module breaks an unrelated module, coupling has been introduced and must be removed.

Design for low coupling.

Shared behaviour belongs in lib, shared, utils or config.

Never in a sibling module.

---

# TESTABILITY

Every service should be independently testable.

Business logic must never require rendering React.

---

# PERFORMANCE

Prefer:

Memoization

Lazy Loading

Code Splitting

Query Caching

Avoid unnecessary renders.

---

# SECURITY

Never expose:

Service Keys

Database Secrets

Environment Variables

Only NEXT_PUBLIC variables may reach the browser.

---

# SCALABILITY

Architecture must support:

100,000+ Accounts

500,000+ Profiles

Millions of Orders

Without redesign.

---

# FUTURE FEATURES

Architecture must support future additions without modification of existing modules.

Open for extension.

Closed for modification.

---

# AMENDMENTS

## Version 1.1

Date

2026-08-07

Approved by

Yasser Saidi

Change

The ROUTES section previously listed seven private routes and contradicted the ten-item Sidebar defined in 04_UI_GUIDELINES.md.

Three routes were missing.

Quick Prepare

Users

Reports

One route was named inconsistently.

/backup

↓

/backups

Resolution

The Sidebar is now the canonical navigation.

The route list matches it exactly.

---

## Version 1.2

Date

2026-08-07

Approved by

Yasser Saidi

Change

Five architectural rules were added by the project owner.

1

A Database Adapter layer was inserted between Repository and Drizzle.

Services are explicitly forbidden from accessing the database.

2

Every module exposes exactly one public API through index.ts.

Deep imports into module internals are forbidden.

3

Services return Result objects rather than throwing business exceptions.

null and undefined are forbidden as business return values.

4

A centralized error hierarchy rooted at AppError was introduced.

5

Removability became an explicit design constraint.

Reference

See ADR-003.

---

# END

This architecture is LOCKED.

Future implementations must comply with this document.