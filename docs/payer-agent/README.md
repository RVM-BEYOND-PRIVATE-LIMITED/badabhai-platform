# Payer + Agency — Audit & Shipping Documentation

Evidence-based audit of the payer/agency surface: `apps/payer-web`, the `apps/api` payer
endpoints, and `packages/db`.

**Audit date:** 2026-08-11 · **Tree:** `feat/747a-spoken-digit-redaction` @ `b2a197e1`
(0 ahead / 1 behind `origin/main`)

> ## ⚠️ Read `AUDIT_STATUS.md` first
> **7 of 17 dimensions completed.** The audit was cut short by a usage limit. The *structural*
> half (what exists, how it is wired) is done; the *behavioural* half (whether it works, whether
> it is safe) is not. Nothing here reports a completeness percentage, because the dimension that
> produces those numbers did not run.

---

## The one-line answer

There is **no separate Agent web application**. One Next.js app — `apps/payer-web` — serves both
personas via `payers.role` (`employer` | `agent`). Owner ruling (2026-08-11): keep it that way.

---

## Documents

| File | What it holds | Status |
|---|---|---|
| **`AUDIT_STATUS.md`** | Coverage ledger, why it is partial, how to resume | ✅ |
| `ARCHITECTURE.md` | Monorepo map, data seam, request pipeline, tenancy, flags | ✅ Complete |
| `PAYER_API_REGISTER.md` | 38 payer routes, guards, frontend consumers, wiring proved both ways | ✅ Routes complete |
| `AGENT_API_REGISTER.md` | 20 agency routes, flag-gated money surface, parked modules | ✅ Routes complete |
| `ROUTE_REGISTER.md` | 25 pages, gates, boundaries, all 33 Server Actions | ✅ Complete |
| `AUTHORIZATION_MATRIX.md` | 4 principals, 5 guards, the fail-open asymmetry, RLS posture | ⚠️ Model only — per-route IDOR not audited |
| **`DATABASE_AUDIT.md`** | 26 tables, indexes, constraints, money integrity, migrations | ✅ **Complete — 18 findings** |
| `GAP_REGISTER.md` | 36 gaps + 7 owner rulings | ⚠️ From 7 of 17 dimensions |
| `LOCAL_SETUP.md` | Verified run recipe + the login blocker | ✅ Read-derived |
| `IMPLEMENTATION_PLAN.md` | 8 dependency-ordered phases + Definition of Done | ✅ |

✅ **Published 2026-08-11** after the audit was resumed and completed:

| File | What it holds |
|---|---|
| **`SECURITY_AUDIT.md`** | 21 findings, 3 P0. **The Phase 3.4 route list lives here** |
| `BUSINESS_FLOWS.md` | P1–P9 and A1–A6 traced hop by hop, with a per-flow "what a real user gets today" verdict |
| `STATE_MACHINES.md` | Every status entity: states, transitions, where enforced, race exposure |
| `API_CONTRACTS.md` | Frontend Zod ⇄ backend DTO parity, plus a Flutter cross-check |
| `ENTERPRISE_READINESS.md` | Reliability, observability, performance, scalability, UX/a11y |
| `TESTING_STRATEGY.md` | Coverage gaps + the proposed test matrix |
| `PAYER_FEATURE_AUDIT.md` · `AGENT_FEATURE_AUDIT.md` | Per-endpoint status classification |
| `ROUTE_REGISTER_FULL.md` | Full per-route UI completeness pass |

Still outstanding: `SHIPPING_CHECKLIST.md`, the Flutter `apps/payer-app` deep-dive, and the
`apps/web` / `apps/admin-web` sole-consumer audit.

---

## The five things that matter most

1. **Tenancy is the real blocker.** `org_id` exists on **one** table in the whole schema
   (`payer_members`). All 19 payer-owned business tables are scoped by the individual login's
   `payer_id`. The Team feature is not stubbed — it is **unrepresentable at the data layer**.
   *(`PAY-DB-01`)*
   → ✅ **RULED 2026-08-11: org-as-tenant.** Now active work, `IMPLEMENTATION_PLAN.md` Phase 3,
   gated on the audit completing first. The three sub-steps (migration, predicate rewrite,
   backend Owner gates) ship as **one** change — a partial migration is worse than none.

2. **`/credits` and `/team` are 404 for every real user.** `getOrgRole()` hard-returns
   `"recruiter"` outside dev, and the nav still links to both. **Do not fix this first** — opening
   the gate would show empty pages instead of not-found pages. *(`GAP-FE-01`)*

3. **`apps/payer-web` is deployed by nothing.** No workflow builds or ships it;
   `staging-cd.yml` explicitly skips the Next apps. There is no hosting config. *(`GAP-XC-06`)*

4. **Nothing can be verified end-to-end today.** Payer login is email OTP with no dev echo, no
   mock provider, and no test-login seam. Four payer e2e suites are hard-skipped, and there are
   **zero** browser tests repo-wide. *(`GAP-LOCAL-01`, `GAP-XC-07`)*

5. **Tenant isolation is application-layer only.** RLS is `FORCE` with **zero policies** and the
   API runs as `BYPASSRLS`. That makes a leaked Supabase key harmless — but it also means a
   single missing `payer_id` predicate is a direct cross-tenant read, with no second line of
   defence. Per-route verification did not run. *(`AUTHORIZATION_MATRIX.md`)*

---

## What is genuinely solid

Worth stating plainly, because an audit that only lists defects misleads:

- **The frontend data seam is well built.** One server-only transport, JWT from an httpOnly
  cookie, never a client-supplied `payer_id`, every response Zod-parsed. The mock store is gone
  and a test actively asserts it stays gone.
- **Money writes are transactional and idempotent.** Atomic conditional decrement, balance +
  ledger in one transaction, a non-negative CHECK, three independent idempotency layers on
  payments. What is missing is *reconciliation*, not correctness.
- **Migration hygiene is real.** Journal contiguous 0→73, not one `DROP TABLE`/`DROP COLUMN`
  repo-wide, RLS enabled and forced on all 65 tables.
- **The no-oracle discipline is consistent.** Role mismatches return a neutral 404 everywhere —
  frontend gates and backend guards alike. A Recruiter cannot even learn an Owner route exists.
- **Fail-closed by default.** Nine boot asserts refuse a half-configured "real" path; every
  feature flag defaults OFF; unset internal secrets deny all.
- **Parked surfaces are mostly honest.** `/agency/bulk-upload` states outright that the feature
  will not be built, and why. That is the model the rest of the honest-UI sweep should follow.

---

## Method

Read-only static analysis. Claims carry `file:line` citations; a page, route, type, or test name
was never taken as evidence that a thing works. Where business intent was genuinely ambiguous it
was recorded as an **ambiguity requiring an owner ruling**, not resolved by invention.

**Caveats:** no application was run, no request issued, no live database inspected — every
finding is static-analysis grade. And `docs/` on `origin/main` holds only 5 files: **12 ADRs
cited throughout the code have no file on main**, so several "is this still intended?" questions
cannot be answered from the repository at all.
