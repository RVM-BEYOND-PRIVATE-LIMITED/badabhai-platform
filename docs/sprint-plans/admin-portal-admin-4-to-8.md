# Admin Portal — ADMIN-4 → ADMIN-8 implementation brief

> **This is the entry point for the dedicated Admin Portal thread.** Read it before writing
> any code. It exists because the backend thread (2026-08-03) finished the foundation and
> knows things about the backend surface that are not obvious from reading it cold.
>
> Owner ruling 2026-08-03: **ADMIN-4 → ADMIN-8 → portal verification → OBS-4 cutover →
> readiness review → release. Do not invert this order.**

---

## 1. What is actually done

Verified at HEAD `2e536bb6`, not assumed:

| Component | State | Where |
|---|---|---|
| Admin principal + session | ✅ | `AdminAuthGuard`, `AdminSessionService` |
| RBAC + capability matrix | ✅ deny-by-default | [`admin-capabilities.ts`](../../apps/api/src/admin/admin-capabilities.ts) |
| MFA (TOTP) | ✅ seed encrypted at rest | `admin_users.mfa_secret_enc` (ADR-0038) |
| First-admin bootstrap | ✅ CLI | `pnpm --filter @badabhai/db db:bootstrap:admin` |
| Email delivery (all principals) | ✅ one pipeline | `EmailNotificationService` (ADR-0038) |
| Governed admin actions + events | ✅ | `AdminActionsService`, `admin.action_performed` |
| Payer lifecycle + suspension | ✅ | ADR-0037 |

**Admin login works end-to-end** and is pinned by [`admin-login-chain.test.ts`](../../apps/api/src/admin/admin-login-chain.test.ts).

---

## 2. Two corrections to "the backend is complete"

Both were verified in code. Neither is a blocker, but building without knowing them wastes a sprint.

### 2.1 `audit_logs` has **zero writers**

The table exists in the schema. **Nothing in the repository writes to it** — confirmed by grepping every non-test source file. Audit today is the **events spine**: the value-free `admin.action_performed` plus the domain events (`payer.suspended`, `agency_kyc.verified`, …).

**Consequence for the portal:** the Audit screen (Phase 3) reads **`GET /admin/events`**, not `audit_logs`. Do not build a UI against an empty table. If the 13-field audit record is wanted (Actor, Role, Capability, Reason, Target, Timestamp, IP, Session, Correlation ID, Before, After, Result, Failure reason), that is a **backend** work item and belongs in the backend thread, not here.

### 2.2 The admin backend is **24 routes**, and they are not the routes Phases 2–4 need

Complete inventory:

| Group | Routes |
|---|---|
| Auth | `POST /admin/login/request`, `/login/verify`, `/mfa/verify`, `/refresh`, `/logout`, `GET /admin/me` |
| Events | `GET /admin/events`, `/events/metrics`, `/events/export`, `/events/trace/:correlationId`, `/events/:id` |
| Timeline | `GET /admin/entities/:type/:id/timeline` |
| Governed actions | `POST /admin/payers/:id/suspend`, `/reinstate`, `/credits`, `/job-postings/:id/close`, `/workers/:id/flag`, `/unflag` |
| Admin management | `POST /admin/admins`, `PATCH /admin/admins/:id/role`, `POST /admin/admins/:id/suspend` |
| PII | `POST /admin/workers/:id/reveal-contact` |
| Kill switch | `GET /admin/kill-switch/status`, `POST /admin/kill-switch/pause-request` |

**There is no admin-guarded LIST or DETAIL endpoint for workers, companies, agencies, jobs, applications, credits or transactions.** Those reads exist only under `InternalServiceGuard` (`GET /workers`, `/job-postings`, `/ai-jobs`, `/events`, `/pricing/catalog`, `/pace/alerts`, `/ops/agency-kyc/pending`) — the internal-token principal the ops console uses.

**Consequence for the portal:**

- **Phase 1 needs no new backend.** Auth, session, MFA, shell, navigation and a dashboard built on `GET /admin/events` + `/events/metrics` are fully served today.
- **Phases 2–4 need ADDITIVE admin-guarded read endpoints.** That is not "redesigning backend behaviour" and it is **not** the OBS-4 cutover: it adds `@UseGuards(AdminAuthGuard, AdminRolesGuard)` read routes alongside the existing internal ones, leaving the ops console untouched and running. OBS-4 later just retires the duplicates.

Raise each new read endpoint as a small backend PR. Do not widen an `InternalServiceGuard` route to accept an admin session — a guard union is the fail-open shape this codebase deliberately avoids.

---

## 3. Guardrails (non-negotiable)

1. **Consume, don't redesign.** Reuse the controllers, services, guards, DTOs, events, audit and capability matrix. New backend = additive read endpoints only, each its own PR.
2. **Role-aware UI must mirror `ADMIN_CAPABILITY_MATRIX`, never re-implement it.** Import the matrix; do not hardcode role lists in the frontend. The server is the authority — the UI hides what a role cannot do, it does not *enforce* it.
   - `reveal_pii` is **`support` + `super_admin` only** (ops_admin and analyst are denied).
   - `export` deliberately **excludes `support`** — the PII-reveal role must not also bulk-export.
   - `toggle_kill_switch` and `manage_admins` are **`super_admin` only**.
3. **PII is allow-list projected.** `POST /admin/workers/:id/reveal-contact` is the *only* contact path and it is capability-gated + audited. No screen may render worker contact detail obtained any other way.
4. **Design system only.** [`docs/design/BadaBhai Design System`](../design/) + the `bb-design-system` skill. No RVMCAD branding, no placeholder UI, no developer tooling exposed.
5. **Every privileged action shows its audit trail.** If a screen can suspend, grant, close or reveal, it must also be able to show the resulting event.

---

## 4. Module order (owner-set)

**Phase 1 — foundation.** Authentication · Session · MFA · Admin shell · Navigation · Dashboard.
*Backend needed: none.*

**Phase 2 — supply & demand.** Workers · Companies · Agencies · Jobs · Applications · Matching · Visibility.
*Backend needed: admin-guarded list/detail reads for each.*

**Phase 3 — money & evidence.** Credits · Wallet · Transactions · Finance · Reports · Audit · Events.
*Backend needed: admin-guarded reads over `credit_ledger`, `payer_credits`, `payment_orders`. Audit = the events spine (§2.1).*

**Phase 4 — control plane.** Configuration · Roles · Capabilities · Admins · Notifications · System health · Queues · Logs · Feature flags (**read / fail-safe only**).
*Backend needed: read endpoints; kill-switch already exists.*

---

## 5. Per-module verification gate

No module is complete until all of these pass — the same bar the backend thread held:

API · Permissions (each role, including the denied ones) · Audit · Events · Pagination · Search · Filters · Responsive · Accessibility · Performance · Error states · Loading states · Security.

**Evidence, not assertion.** A passing test counts only after it has been seen to fail — mutate the guard check, the capability lookup and the empty/error branch, and confirm each is caught. The backend thread ran 26 + 17 mutations this way; the same standard applies here.

---

## 6. Where things live

| Thing | Path |
|---|---|
| Ops console (today's UI, **keep running**) | [`apps/web`](../../apps/web) |
| Payer portal (design reference for quality bar) | [`apps/payer-web`](../../apps/payer-web) |
| Design system | [`docs/design/`](../design/) + `bb-design-system` skill |
| Admin backend | [`apps/api/src/admin/`](../../apps/api/src/admin/) |
| Capability matrix | [`admin-capabilities.ts`](../../apps/api/src/admin/admin-capabilities.ts) |
| ADRs | [ADR-0025](../decisions/0025-admin-ops-portal.md) · [ADR-0037](../decisions/0037-payer-lifecycle-and-suspension.md) · [ADR-0038](../decisions/0038-admin-bootstrap-and-notification-layer.md) |

**Open question for the owner, before Phase 1 lands:** does the Admin Portal live in `apps/web` (replacing the ops console in place, which makes OBS-4 a deletion) or in a new `apps/admin-web` (which makes OBS-4 a DNS/route switch and lets both run side by side during verification)? The second is lower risk and matches "the migration should be a simple routing change"; the first avoids a fourth Next.js app. **Not decided.**

---

## 7. Explicitly NOT in this thread

These stay with the backend thread:

- **OBS-4 ops cutover** — only after ADMIN-8 is verified.
- **TD130** (auth timing equalization, P1) — after ADMIN-8, unless portal work naturally touches the auth flow.
- **The 13-field audit record** / `audit_logs` writers (§2.1).
- The final deliverables: Production Readiness, Security Validation, Architecture Consistency, Tech-Debt Register (P0/P1/P2), Roadmap v2, Operational Runbook, DR & Rollback Guide.

---

## 8. First actions for the fresh thread

1. Read this file, [ADR-0025](../decisions/0025-admin-ops-portal.md) and [ADR-0038](../decisions/0038-admin-bootstrap-and-notification-layer.md).
2. Get the owner's ruling on §6 (`apps/web` vs `apps/admin-web`).
3. Run the bootstrap CLI against a local DB and complete a real login — **verify the foundation before building on it** rather than trusting this document.
4. Build Phase 1. It needs no backend work, so it is the cleanest possible proof that the foundation holds.
