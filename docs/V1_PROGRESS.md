# V1 Progress

Date: 2026-08-08
Milestone: M04.8

---

## Completed Milestones

| # | Milestone | Delivered |
| - | --------- | --------- |
| M01 | Foundation & Authentication | Next.js 16, design system, auth, shell, protected routes |
| M01.5 | Infrastructure Verification | Docs, `npm run verify`, 4 defects fixed |
| M02 | Domain & Database | 8 tables, 9 enums, repositories, adapter, migrations |
| M03 | Accounts & Profiles | Full CRUD, five-profile rule, timeline, audit |
| M04 | Quick Prepare | Allocation engine, phone + clipboard engines, replacement |
| M04.5 | Runtime Verification | 55 live checks, BUG-01 found and fixed |
| M04.8 | Production Hardening | RLS lockdown, 147 tests, CI, security audit |

---

## Completion — approximately 55%

Percentages are of V1 scope as defined by `.ai/`, weighted by remaining effort.

| Area | Complete | Note |
| ---- | -------- | ---- |
| Foundation & architecture | 100% | Frozen and enforced |
| Database schema | 90% | Orders, issues, notifications outstanding |
| Authentication | 80% | Works; RBAC inert, UI unverified |
| Accounts & Profiles | 90% | Built and verified at the data layer |
| Quick Prepare | 90% | Built and verified at the data layer |
| Security | 70% | RLS closed; RBAC and rate limiting open |
| Testing | 60% | 147 tests; authenticated and DB paths uncovered |
| Customers | 10% | find-or-create only |
| Dashboard | 5% | Placeholder |
| Search | 0% | |
| Reports | 0% | Blocked on orders |
| Backups | 5% | Table only |
| Users & Workers | 15% | Table and roles, no UI |
| Notifications | 0% | |
| Migration from Sheets | 0% | |
| Monitoring | 10% | Structured logging only |

---

## Remaining Milestones

| # | Milestone | Depends on |
| - | --------- | ---------- |
| M05 | Customers | — |
| M06 | Orders | — |
| M07 | Search Engine | Customers |
| M08 | Dashboard & Reports | Orders |
| M09 | Users & Workers | RBAC wiring |
| M10 | Problems & Issues | — |
| M11 | Notifications | — |
| M12 | Backup Engine | — |
| M13 | Google Sheets Migration | Customers, Orders |
| M14 | Expiry Automation | — |
| M15 | Production Deployment | All of the above |

---

## Roadmap

**Immediate — should precede M05**

1. Sign in once so the authenticated UI can be verified. Four milestones of UI
   are still unexercised.
2. Wire `toAppUser` to read `role`. One change unblocks all authorization.
3. Add an integration test suite so the M04.5 database checks become permanent.

**Then, in dependency order**

Orders before Reports. Customers before Search. RBAC before Workers.

Expiry automation matters more than its position suggests: `expiring_soon` and
`expired` are never written today, so an ended subscription still reads as sold.

---

## Estimated V1 Completion

Roughly **45% of the work remains**, and it is weighted toward breadth — many
smaller modules rather than another engine of Quick Prepare's difficulty.

The genuine unknowns are the Google Sheets migration, whose difficulty depends
entirely on the real data's shape, and the first production deployment.

The three highest-leverage things are not features:

1. **Verify the authenticated UI.** Four milestones of screens have never
   rendered to a signed-in user.
2. **Keep tests permanent.** BUG-01 survived three milestones of green builds;
   SEC-01 survived four. Both were invisible to the checks in place.
3. **Test the rollback** while it is still free to do so.
