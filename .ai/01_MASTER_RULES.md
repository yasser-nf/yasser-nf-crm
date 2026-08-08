# Yasser NF CRM
# MASTER RULES

Version: 1.0
Status: LOCKED
Owner: Yasser Saidi

---

# PURPOSE

This document defines the permanent engineering rules for the Yasser NF CRM project.

These rules are mandatory.

Every future implementation, architecture decision, database modification, UI component, service, API, and feature must comply with this document.

These rules override implementation preferences.

Claude Code must never violate these rules unless explicitly instructed by the project owner.

---

# PROJECT IDENTITY

Project Name

Yasser NF CRM

Project Type

Private Internal CRM

Purpose

Internal Netflix Subscription Management System.

This project replaces Google Sheets completely.

It is NOT:

- SaaS
- Marketplace
- Public Application
- Customer Portal
- E-commerce

It is a private internal operating system.

---

# PROJECT GOALS

The system must prioritize:

1. Reliability
2. Speed
3. Simplicity
4. Scalability
5. Maintainability

Every engineering decision must optimize these five principles.

---

# DEVELOPMENT PHILOSOPHY

Before writing code:

Analyze.

Plan.

Explain.

Implement.

Review.

Refactor.

Test.

Never skip any step.

Never guess requirements.

Always prefer maintainability over shortcuts.

---

# CODE QUALITY

The project must always remain production-ready.

Forbidden:

- Temporary fixes
- Prototype code
- Quick hacks
- Dead code
- Commented-out code
- Duplicate logic
- Hardcoded business data
- Hardcoded secrets

---

# ARCHITECTURE

Use Feature-Based Architecture.

Each module owns its own:

- components
- hooks
- services
- types
- utils

Business logic must never exist inside:

- pages
- layouts
- UI components

Business logic belongs inside services.

---

# TYPESCRIPT

TypeScript Strict Mode is mandatory.

Rules:

- No "any"
- Strong typing everywhere
- Explicit interfaces
- Explicit return types when appropriate

Type safety has higher priority than development speed.

---

# CODING STANDARDS

Follow SOLID principles.

Follow Clean Code principles.

Follow Single Responsibility Principle.

Prefer composition over inheritance.

Prefer readable code over clever code.

Never duplicate business logic.

Always create reusable utilities.

---

# FILE ORGANIZATION

Prefer small files.

Recommended limits:

Components

< 250 lines

Hooks

< 200 lines

Services

< 300 lines

Split large files whenever necessary.

---

# NAMING

Use meaningful names.

Avoid abbreviations.

Good:

AccountTimeline

Bad:

AccTime

Good:

normalizePhone()

Bad:

phoneFix()

---

# UI PHILOSOPHY

Desktop First.

Responsive Mobile.

Dark Theme Only.

No Light Theme.

Inspired by:

- Linear
- Stripe
- Notion
- Vercel Dashboard

Never imitate:

- WordPress Admin
- Bootstrap Dashboards
- Generic Admin Templates

---

# DESIGN PRINCIPLES

Minimal UI

Large spacing

Rounded corners

Soft shadows

Smooth animations

Glass effects (subtle)

Consistent typography

Consistent spacing

Consistent iconography

---

# LOADING

Never use ugly loading spinners.

Always prefer:

- Skeleton loading
- Progressive rendering
- Optimistic UI where appropriate

---

# EMPTY STATES

Every page must define an Empty State.

Include:

- Illustration or icon
- Short explanation
- Primary action button

---

# ERROR HANDLING

Every error must include:

- Friendly message
- Retry action
- Safe recovery path

Never expose stack traces or technical details.

---

# PERFORMANCE

Dashboard

Target < 1 second

Search

Instant

Quick Prepare

Target < 5 seconds

Always use:

- Pagination
- Lazy loading
- Query caching

Avoid unnecessary renders.

---

# DATABASE PRINCIPLES

Database must be normalized.

Use:

- Foreign keys
- Constraints
- Indexes

Avoid duplicated information.

Never denormalize without architectural justification.

---

# ACCOUNT RULES

Each Netflix Account always contains exactly:

5 Profiles

Never allow:

4 Profiles

6 Profiles

Dynamic profile count

---

# PROFILE STATES

Allowed values:

- Available
- Reserved
- Sold
- Expiring Soon
- Expired

No additional states unless approved.

---

# ACCOUNT STATUS

Allowed values:

- Healthy
- Payment Problem
- Incorrect Password
- Invalid Email
- Something Went Wrong
- Archived
- Deleted

Business Rule:

If an Account is not Healthy,

ALL Profiles automatically become unavailable.

No exceptions.

---

# CUSTOMER RULES

Customer uniqueness is determined by:

Normalized WhatsApp Number.

Examples

+213 663 94 71 16

↓

663947116

Store:

- Original Number
- Normalized Number
- WhatsApp URL

Automatically generate:

https://wa.me/213XXXXXXXXX

---

# SMART STOCK ENGINE

Never choose the first available account.

Calculate a score.

Prioritize:

- Healthy Accounts
- Available Profiles
- Best Distribution
- Highest Health Score
- Lowest Problem History

Never return problematic accounts.

---

# SEARCH ENGINE

Search across:

- Accounts
- Profiles
- Customers
- Orders
- Email
- Password
- Phone
- PIN
- Notes

Search must be instant.

---

# BACKUP

Support:

- Hourly Backup
- Daily Backup
- Manual Backup
- Restore Points

All backups must be restorable.

---

# SECURITY

Mandatory:

- Protected Routes
- Role-Based Access
- Encrypted Sensitive Data
- Audit Logging
- Session Validation

Never expose secrets.

Never expose service keys.

Never trust client input.

---

# USER ROLES

Supported Roles:

Super Admin

Worker

Workers cannot:

- Delete Accounts
- Access Backup
- Access Settings
- Manage Users
- View sensitive system information

---

# AUDIT LOG

Every important action must be logged.

Audit logs are immutable.

Never delete.

Never modify.

---

# TIMELINE

Every Account owns its own Timeline.

Every important action automatically creates a Timeline event.

---

# GOOGLE SHEETS

Google Sheets exists only for migration.

After migration:

Google Sheets is no longer used.

The CRM becomes the single source of truth.

---

# DEPENDENCIES

Only install dependencies that provide clear value.

Avoid unnecessary packages.

Prefer native browser APIs whenever practical.

---

# DOCUMENTATION

Complex services must be documented.

Complex business rules must include comments explaining WHY, not WHAT.

---

# TESTING

No Milestone is complete without:

- Manual testing
- Edge case testing
- Self review

---

# GIT

Small commits.

Meaningful commit messages.

Never commit broken code.

---

# AI DEVELOPMENT WORKFLOW

Every milestone follows:

1. Analyze

2. Architecture Plan

3. Database Impact

4. UI Impact

5. Implementation

6. Self Review

7. Refactor

8. Test

9. Final Review

Never skip steps.

---

# WHEN UNSURE

Do not guess.

Stop.

Explain the uncertainty.

Suggest options.

Wait for approval.

---

# PROJECT PHILOSOPHY

Yasser NF CRM is an enterprise-quality internal operating system for managing Netflix subscriptions.

Every engineering decision must improve:

- Reliability
- Performance
- Maintainability
- Scalability
- Developer Experience
- User Experience

The system is expected to be maintained for many years.

Think like a Senior Software Architect.

Not like an AI code generator.

---

# END OF DOCUMENT

This document is LOCKED.

Future architectural decisions must respect these rules unless the project owner explicitly approves an exception.