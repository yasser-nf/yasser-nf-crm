# ADR-004
# Next.js 16 Adoption

Status: ACCEPTED

Date: 2026-08-07

Owner: Yasser Saidi

Amends: ADR-001

---

# Context

ADR-001 adopted Next.js 15 with the App Router.

At the time that decision was written, Next.js 15 was the current major release.

That is no longer true.

Current state of the ecosystem

next@latest

16.3.0

Latest Next.js 15 release

15.5.23

The 15.x line has moved to maintenance.

It receives backported security fixes.

It does not receive feature work.

ADR-001 states that changing an adopted technology requires a new ADR, justification and approval from the project owner.

This ADR provides all three.

---

# Decision

Next.js 16.3.0 is adopted.

The App Router decision from ADR-001 is unchanged.

---

# Justification

## The migration cost never gets lower

This project has written zero application files.

Migrating an empty scaffold from 15 to 16 costs nothing.

Migrating a complete CRM later costs a great deal.

Choosing 15 today does not avoid the migration.

It only schedules it for a worse moment.

## The ten year argument cuts toward 16

ADR-001 justifies its choices by the expectation that this system is maintained for many years.

That same reasoning applies here.

Starting a greenfield project one major version behind means beginning with inherited technical debt.

## The locked stack is unaffected

React 19

Tailwind CSS v4

shadcn/ui

Drizzle ORM

Supabase

TanStack Query

Zustand

React Hook Form

Zod

Framer Motion

All are supported identically on Next.js 16.

No other ADR-001 decision changes.

---

# Consequences

## Turbopack becomes the default bundler

Turbopack is the default in Next.js 16.

The create-next-app --turbopack flag no longer exists because the behaviour is now standard.

## Documentation drift

Most existing tutorials and community answers currently target Next.js 15.

When guidance conflicts, the official Next.js 16 documentation is authoritative.

## Future major versions

Adopting the current major does not authorize automatic upgrades.

Moving to Next.js 17 will require its own ADR.

---

# Rejected Alternative

Next.js 15.5.23

Rejected because the 15.x line is maintenance-only, and adopting it would create a known migration obligation on a project that has not yet written its first file.

The alternative was considered seriously.

Its genuine advantage is ecosystem documentation match.

That advantage was judged smaller than the cost of a deferred major migration.

---

# Document Updates Required

02_ARCHITECTURE.md

No change required.

The App Router decision is unchanged.

CURRENT_MILESTONE.md

Task 1 updated from Next.js 15 to Next.js 16.

---

# Final Decision

Next.js 16.3.0 is adopted.

Approved by the project owner on 2026-08-07.

---

END OF ADR-004
