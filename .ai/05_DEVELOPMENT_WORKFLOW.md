# Yasser NF CRM
# DEVELOPMENT WORKFLOW

Version: 1.0
Status: LOCKED

---

# PURPOSE

This document defines the mandatory software development workflow for Yasser NF CRM.

Every milestone, feature, bug fix and refactor must follow this workflow.

No implementation may skip these rules.

---

# DEVELOPMENT PHILOSOPHY

Build slowly.

Build correctly.

Never rush.

Never sacrifice architecture for speed.

Every completed feature should be production-ready.

---

# SOURCE OF TRUTH

The following documents define the project.

Priority order:

1. 01_MASTER_RULES.md
2. ADR Documents
3. 02_ARCHITECTURE.md
4. 03_DATABASE.md
5. 04_UI_GUIDELINES.md
6. CURRENT_MILESTONE.md

If documents conflict:

Stop.

Ask for clarification.

Never guess.

---

# DEVELOPMENT CYCLE

Every task follows exactly this order.

1. Analyze

Understand the request.

Understand the business rules.

Understand database impact.

Understand UI impact.

---

2. Plan

Describe

Files

Components

Database changes

Services

Risks

No code yet.

---

3. Approval

If architecture changes are required

Stop.

Wait for approval.

---

4. Build

Implement the smallest complete solution.

Never build multiple unrelated features.

---

5. Self Review

Review your own code.

Check

Readability

Architecture

Performance

Security

Type Safety

---

6. Refactor

Improve code.

Reduce duplication.

Simplify logic.

---

7. Test

Run

Lint

Type Check

Manual Testing

Edge Cases

---

8. Complete

Summarize

Files Created

Files Modified

Database Changes

Next Steps

---

# MILESTONE RULES

A milestone has exactly one goal.

Example

Milestone 1

Foundation

Milestone 2

Authentication

Milestone 3

Accounts

Never mix milestones.

---

# DEFINITION OF DONE

A task is complete only if:

✅ Code compiles

✅ No TypeScript errors

✅ No ESLint errors

✅ UI matches design

✅ Responsive works

✅ Business rules respected

✅ Manual testing completed

✅ Documentation updated

If one item fails

Task is NOT complete.

---

# GIT STRATEGY

One feature

↓

One commit

Commit messages

feat(auth): add login page

fix(search): normalize phone numbers

refactor(accounts): simplify stock engine

docs(database): update schema

Never use

update

changes

fix

without context.

---

# BRANCH STRATEGY

main

Always stable.

develop

Current development.

feature/*

One feature only.

Example

feature/authentication

feature/accounts

feature/search

feature/backup

---

# PULL REQUEST CHECKLIST

Before merging

Review

Architecture

Naming

Performance

Security

Accessibility

Responsiveness

Documentation

No duplicated code

---

# CODE REVIEW CHECKLIST

Ask

Can this be simpler?

Can this be smaller?

Can this be reused?

Is naming obvious?

Would another developer understand it immediately?

If not

Improve it.

---

# COMPONENT CHECKLIST

Every component

One responsibility

Typed

Reusable

Accessible

Responsive

Small

---

# SERVICE CHECKLIST

Every service

Pure business logic

No UI

Typed

Testable

Reusable

---

# DATABASE CHECKLIST

Every migration

Reviewed

Reversible

Safe

Indexed

No duplicated columns

No unnecessary tables

---

# SECURITY CHECKLIST

Never trust frontend.

Validate input twice.

Protect routes.

Protect APIs.

Protect secrets.

Never expose service keys.

---

# UI CHECKLIST

Spacing consistent

Typography consistent

Animations subtle

Dark theme respected

Loading states exist

Empty states exist

Error states exist

---

# PERFORMANCE CHECKLIST

Avoid unnecessary renders.

Memoize expensive calculations.

Lazy load large modules.

Cache server data.

Paginate large tables.

Never load unnecessary data.

---

# ERROR HANDLING

Every operation returns

Success

Failure

Meaningful message

Recovery action

Never fail silently.

---

# TESTING

Every feature must be tested.

Minimum tests

Happy Path

Invalid Input

Permission Check

Edge Cases

Unexpected State

---

# BUG SEVERITY

Critical

Application unusable.

High

Business rule broken.

Medium

Feature partially broken.

Low

Visual issue.

---

# REFACTOR POLICY

Refactor immediately if

Duplication appears.

Naming becomes unclear.

Component grows too large.

Service has multiple responsibilities.

---

# DOCUMENTATION

Whenever architecture changes

Update documentation first.

Then implement.

Documentation never lags behind code.

---

# CLAUDE CODE BEHAVIOR

Claude must never

Guess

Invent business rules

Change architecture

Replace technologies

Ignore documentation

Skip testing

Claude must always

Read .ai documents

Respect ADR decisions

Follow milestones

Report progress

Stop when milestone is complete

---

# END OF EVERY TASK

Always report

## Summary

Completed work

Files created

Files modified

Database changes

Known limitations

Next milestone

---

# FINAL PHILOSOPHY

The goal is not to write code.

The goal is to build a system that remains clean, scalable and maintainable for the next ten years.

Every line of code is a long-term investment.

Always optimize for clarity over cleverness.

Always optimize for maintainability over speed.

Build software that another senior engineer would enjoy maintaining.

---

END OF DOCUMENT