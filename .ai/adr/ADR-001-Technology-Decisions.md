# ADR-001
# Technology Decisions

Status: ACCEPTED

Date: 2026-08-07

Owner: Yasser Saidi

---

# Context

Yasser NF CRM is expected to become a long-term internal operating system for managing Netflix subscriptions.

The project is expected to evolve for years.

The architecture must prioritize:

- Reliability
- Maintainability
- Scalability
- Developer Experience
- Performance

Technology choices are therefore considered architectural decisions and may not be changed without explicit approval.

---

# Decision

The following technologies are officially adopted.

---

# Frontend Framework

## Decision

Next.js 15 (App Router)

## Why

App Router is the future of React.

Excellent routing.

Excellent layouts.

Excellent middleware.

Excellent performance.

Easy deployment on Vercel.

Supports future server-side features without redesign.

---

# Language

## Decision

TypeScript

Strict Mode Enabled

## Why

Compile-time safety.

Better refactoring.

Better IntelliSense.

Fewer production bugs.

---

# Styling

## Decision

Tailwind CSS

## Why

Consistent design system.

Fast development.

Easy maintenance.

No CSS framework dependency.

---

# UI Components

## Decision

shadcn/ui

## Why

Beautiful.

Accessible.

Customizable.

No vendor lock-in.

Built on Radix UI.

---

# Icons

## Decision

Lucide React

## Why

Modern.

Lightweight.

Consistent.

Tree-shakeable.

---

# Animations

## Decision

Framer Motion

## Why

Professional animations.

Smooth transitions.

Modern UX.

---

# Backend Platform

## Decision

Supabase

## Why

Authentication.

PostgreSQL.

Storage.

Realtime.

Row Level Security.

Edge Functions.

Excellent integration with Next.js.

---

# Database

## Decision

PostgreSQL

Hosted by Supabase.

## Why

Reliable.

Powerful.

Scalable.

Industry standard.

---

# ORM

## Decision

Drizzle ORM

## Why

Type-safe.

Fast.

Excellent TypeScript support.

SQL-first.

Simple migrations.

Works perfectly with PostgreSQL.

---

# Why NOT Prisma?

Prisma is an excellent ORM.

However,

Drizzle was selected because:

- Better SQL transparency
- Faster startup
- Lower runtime overhead
- Easier migrations
- Better integration with PostgreSQL
- Better developer experience for this project

---

# Authentication

## Decision

Supabase Auth

## Why

JWT support.

Role management.

Session handling.

Secure.

Well integrated.

---

# State Management

## Decision

Zustand

## Why

Minimal.

Fast.

Simple.

No boilerplate.

Perfect for UI state.

---

# Server State

## Decision

TanStack Query

## Why

Caching.

Optimistic updates.

Background refetching.

Excellent developer experience.

---

# Forms

## Decision

React Hook Form

## Why

High performance.

Minimal re-rendering.

Great TypeScript support.

---

# Validation

## Decision

Zod

## Why

Single source of truth.

Type-safe validation.

Frontend + backend validation.

---

# Deployment

## Decision

Vercel

## Why

Best integration with Next.js.

Automatic deployments.

Preview deployments.

Excellent performance.

---

# Version Control

## Decision

Git

GitHub

## Why

Industry standard.

History.

Code review.

Rollback capability.

---

# Code Formatting

## Decision

Prettier

## Why

Consistent formatting.

No style debates.

---

# Linting

## Decision

ESLint

## Why

Prevent bugs.

Improve consistency.

---

# Git Hooks

## Decision

Husky

lint-staged

## Why

Prevent broken commits.

Run linting automatically.

---

# Package Manager

## Decision

npm

## Why

Stable.

Universally supported.

Simple.

---

# Environment Variables

Only use

.env.local

Secrets never enter Git.

Never expose service keys.

Only NEXT_PUBLIC variables may reach the client.

---

# Architecture Style

Feature-Based Architecture

Chosen over Layer-Based Architecture.

Reason:

Business modules remain isolated.

Easier maintenance.

Better scalability.

---

# Design Philosophy

Desktop First.

Responsive Mobile.

Dark Theme Only.

Premium Interface.

Inspired by:

- Linear
- Stripe
- Vercel
- Notion

Never imitate:

- Bootstrap Admin
- WordPress Admin

---

# Database Access Strategy

React Components

↓

Feature Services

↓

Repositories

↓

Drizzle ORM

↓

PostgreSQL

React components never communicate directly with the database.

---

# Search Strategy

Global Search Engine.

Every feature registers searchable fields.

Search remains centralized.

---

# Backup Strategy

Hourly Backup.

Daily Backup.

Manual Backup.

Restore Points.

Checksum verification.

---

# Logging Strategy

Every important business action creates:

Audit Log

Timeline Event

Optional Notification

No silent mutations.

---

# Security Strategy

Role-Based Access.

Protected Routes.

Encrypted sensitive data.

Server-side validation.

Never trust frontend input.

---

# Future Compatibility

The selected technologies must support:

100,000+

Accounts

500,000+

Profiles

Millions of Orders

Without architectural redesign.

---

# Final Decision

These technologies are officially adopted.

Changing any technology requires:

1. New ADR

2. Justification

3. Approval from the project owner

No exceptions.

---

END OF ADR-001