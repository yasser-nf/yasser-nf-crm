# Yasser NF CRM
# UI GUIDELINES

Version: 1.0
Status: LOCKED

---

# PURPOSE

This document defines the complete Design System for Yasser NF CRM.

Every page, component, animation and interaction must follow these rules.

No UI implementation may violate this document.

---

# DESIGN PHILOSOPHY

The interface should feel like:

- Linear
- Stripe Dashboard
- Vercel
- Notion

NOT like:

- Bootstrap Admin
- WordPress
- AdminLTE
- Generic dashboards

The experience should feel premium.

Minimal.

Fast.

Elegant.

Focused.

---

# DESIGN PRINCIPLES

Every screen must prioritize

Clarity

Consistency

Speed

Readability

Large spacing

Minimal distractions

Every pixel must have a purpose.

---

# THEME

Dark Theme only.

No Light Theme.

No Theme Switcher.

---

# COLOR SYSTEM

## Background

Primary Background

Dark Navy

Secondary Background

Slightly lighter than primary.

Surface

Cards

Panels

Dialogs

Navigation

All use the Surface color.

---

## Primary Color

Cyan

Used for

Buttons

Links

Selections

Highlights

Focus

---

## Success

Green

---

## Warning

Orange

---

## Danger

Red

---

## Neutral

Gray scale only.

No random colors.

---

# SPACING SYSTEM

Use only

4

8

12

16

20

24

32

40

48

64

Never invent spacing values.

Consistency is mandatory.

---

# BORDER RADIUS

Small

8px

Medium

12px

Large

16px

Dialogs

24px

Never mix random radius values.

---

# SHADOWS

Soft only.

No heavy shadows.

No glowing effects.

---

# TYPOGRAPHY

One font family.

Three weights only.

Regular

Medium

Bold

No extra bold.

No ultra light.

---

# TEXT HIERARCHY

Page Title

Largest

Section Title

Medium

Card Title

Small

Description

Muted

Caption

Smallest

---

# ICONS

Lucide Icons only.

Never mix icon libraries.

Icons should always match text size.

---

# BUTTONS

Primary

Filled

Cyan

Secondary

Outline

Danger

Red

Ghost

Transparent

Icon Button

Square

Loading Button

Spinner inside button

---

# BUTTON RULES

Buttons have one primary action only.

Never display two primary buttons beside each other.

---

# INPUTS

Every input includes

Label

Placeholder

Validation

Error Message

Disabled State

Focus State

Never use floating labels.

---

# FORMS

Spacing between inputs

16px

Section spacing

32px

Always validate immediately after interaction.

---

# TABLES

Every table supports

Pagination

Sorting

Filtering

Search

Loading

Empty State

Responsive behavior

Sticky Header

---

# CARDS

Cards are preferred over large tables whenever possible.

Cards include

Header

Body

Footer (optional)

Actions

---

# MODALS

Rounded corners

Large spacing

Escape closes

Click outside closes

Primary action right

Secondary action left

---

# DRAWERS

Used for

Quick edits

Details

Never for destructive actions.

---

# SIDEBAR

Fixed

Collapsible

Always visible on desktop.

Contains

Dashboard

Accounts

Quick Prepare

Customers

Problems

Users

Reports

Backups

Logs

Settings

---

# TOPBAR

Contains

Search

Notifications

Quick Prepare

Profile Menu

Never overcrowd the topbar.

---

# SEARCH

Global Search

Always accessible.

Shortcut

CTRL + K

Search should feel instant.

---

# LOADING

Use Skeletons.

Never block the entire page.

Avoid full-page loading whenever possible.

---

# EMPTY STATES

Every module must define

Illustration

Title

Description

Primary Action

Example

No Accounts Found

Create your first account.

---

# ERROR STATES

Every error includes

Friendly explanation

Retry Button

Support action if necessary

Never expose technical errors.

---

# TOASTS

Position

Top Right

Duration

3–5 seconds

Types

Success

Info

Warning

Danger

Maximum one stack.

---

# DIALOGS

Use dialogs for

Confirmation

Delete

Replace

Problem Report

Backup Restore

Never overload dialogs.

---

# QUICK PREPARE

This is the flagship feature.

It deserves the highest UI quality.

Use Wizard layout.

Step 1

Profiles

↓

Step 2

Duration

↓

Step 3

Customer

↓

Step 4

Preview

↓

Confirm

---

# ACCOUNT DETAILS

Prefer cards over long forms.

Profile cards should be visually separated.

Each profile has

Status Badge

PIN

Customer

Expiration

Actions

---

# STATUS BADGES

Healthy

Green

Problem

Red

Expiring

Orange

Archived

Gray

Available

Green

Reserved

Blue

Sold

Purple

Expired

Red

---

# NOTIFICATIONS

Bell icon.

Unread badge.

Dropdown.

Grouped by date.

---

# MOBILE

Bottom Navigation

Cards instead of tables

Full-screen dialogs

Large touch targets

Minimum touch target

44x44

---

# DESKTOP

Sidebar

Tables

Keyboard shortcuts

Hover interactions

Multiple columns

---

# ANIMATIONS

Use Framer Motion.

Duration

150ms

200ms

250ms

Never exceed 300ms.

Animations must improve UX.

Never distract.

---

# ACCESSIBILITY

Keyboard navigation

Visible focus

High contrast

Readable font sizes

Semantic HTML

ARIA labels when needed

---

# RESPONSIVE BREAKPOINTS

Mobile

Tablet

Laptop

Desktop

Large Desktop

No horizontal scrolling.

---

# CONSISTENCY

Every page must feel like the same application.

No component should look different from the design system.

---

# FUTURE COMPONENTS

Every new component must

Reuse existing tokens

Reuse spacing

Reuse typography

Reuse animations

Never reinvent styles.

---

# UI REVIEW CHECKLIST

Before approving any UI

Ask:

Is it simple?

Is it beautiful?

Is it fast?

Is it consistent?

Can it be simplified further?

If yes,

simplify it.

---

# FINAL PHILOSOPHY

Good UI is invisible.

Users should think about their work,

not about the interface.

Every screen should reduce cognitive load.

Every interaction should feel obvious.

Every animation should communicate meaning.

The CRM should feel like a premium desktop application running inside the browser.

---

END OF DOCUMENT