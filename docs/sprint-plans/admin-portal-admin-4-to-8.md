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
2. **Role-aware UI renders from `GET /admin/me`'s `capabilities`, never from its own copy of the matrix.** `ADMIN_CAPABILITY_MATRIX` lives inside `apps/api` and cannot be imported by a sibling app, so the server resolves the list and hands it over (added 2026-08-03). Do not hardcode role lists in the frontend. The server is the authority — the UI hides what a role cannot do, it does not *enforce* it, and every route re-checks `@RequireAdminRole` regardless of what the client believes.
   - `reveal_pii` is **`support` + `super_admin` only** (ops_admin and analyst are denied).
   - `export` deliberately **excludes `support`** — the PII-reveal role must not also bulk-export.
   - `toggle_kill_switch` and `manage_admins` are **`super_admin` only**.
3. **PII is allow-list projected.** `POST /admin/workers/:id/reveal-contact` is the *only* contact path and it is capability-gated + audited. No screen may render worker contact detail obtained any other way.
4. **Design system only.** [`docs/design/BadaBhai Design System`](../design/) + the `bb-design-system` skill. No RVMCAD branding, no placeholder UI, no developer tooling exposed.
5. **Shared packages: extract on the second use, not the first.** The platform is heading
   for `packages/ui`, `admin-ui`, `auth`, `permissions`, `events`, `api-client`,
   `design-tokens`, `shared-types` (owner, 2026-08-03). Two cautions from the current
   state, so this lands as consolidation rather than speculation:
   * `packages/` already has 11 members and **none of them is UI**. `apps/payer-web` has
     exactly 5 component entries. There is not yet enough duplicated UI to extract — a
     `packages/ui` created before `admin-web` has real screens would be designed against
     one consumer and refactored the moment the second arrives.
   * `packages/types` and `packages/validators` already carry the shared-types role, and
     `packages/event-schema` already is the events contract. Adding `shared-types` and
     `events` alongside them would create two sources of truth for the same thing.
   **Recommended sequence:** build Phase 1 with local components → when `admin-web` and
   `payer-web` genuinely need the same primitive, extract it *then* → `design-tokens` is
   the exception worth doing early, because the Flutter worker app can consume tokens
   (emitted as JSON/Dart) and cannot consume a React package.

6. **Every privileged action shows its audit trail.** If a screen can suspend, grant, close or reveal, it must also be able to show the resulting event.

---

## 4. Phase order (owner-set, 2026-08-03 — do not invert)

| Phase | Content | Backend needed |
|---|---|---|
| **1** | Create `apps/admin-web` · shell · login · session · MFA · sidebar · navigation · dashboard · event feed · system health | **None** |
| **2** | Additive admin read APIs: workers, companies, agencies, jobs, applications, credits, transactions | New routes only — **do not modify internal ones** |
| **3** | All management modules | — |
| **4** | Audit · Events · Reports · Finance · Admin management · Configuration | — |
| **5** | Full verification | — |
| **6** | OBS-4 cutover | — |
| **7** | Production readiness | — |

Phase 1 needing **no backend at all** is the point: it is the cleanest possible proof
that the foundation holds before anything is built on top of it.

### The Audit screen needs a data-source seam

Audit reads `GET /admin/events` today (§2.1). If the richer 13-field audit record lands
later, the UI should **swap the data source behind an abstraction** rather than being
redesigned. Build the Audit view against a narrow internal interface — `listAuditEntries(query)`
— with the events API as its first implementation, not against the events response shape
directly.

## 5. Per-module verification gate

No module is complete until all of these pass — the same bar the backend thread held:

API · Permissions (each role, including the denied ones) · Audit · Events · Pagination · Search · Filters · Responsive · Accessibility · Performance · Error states · Loading states · Security.

**Evidence, not assertion.** A passing test counts only after it has been seen to fail — mutate the guard check, the capability lookup and the empty/error branch, and confirm each is caught. The backend thread ran 49 mutations this way across the ADR-0037/0038 series; the same standard applies here. Report any mutation that **survived** rather than presenting a clean sheet.

**The workstream is not done when the modules are.** ADMIN-4..8 completes against the
ten-point **Definition of DONE** in [CLAUDE.md §6](../../CLAUDE.md) — architectural +
security verification, mutation testing, **clean-environment verification** (invariant
#10: the portal must come up from an empty database via the runbook, not a long-lived dev
one), DR verification, operational runbook, rollback procedure, performance validation,
documentation, production-readiness checklist.

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

**DECIDED (owner, 2026-08-03): a new `apps/admin-web`.** The admin surface is already a distinct bounded context on the backend — its own authentication, RBAC, capability matrix, bootstrap, MFA, APIs and ADRs — and the frontend mirrors that separation. This buys independent deploys and CI, smaller bundles, clearer ownership and easier security review, and it makes OBS-4 a **traffic switch** rather than an in-place rewrite: the ops console keeps running untouched while the portal is built and verified beside it, and legacy pages retire only once parity is proven.

---

## 7. Thread split (owner, 2026-08-03 — backend is in MAINTENANCE MODE)

**This thread owns:** `apps/admin-web` · admin auth UI · MFA enrolment UI · dashboard ·
navigation · Workers · Companies · Agencies · Jobs · Finance · Credits · Events · Audit
viewer · Reports · Configuration · responsive UX · accessibility · enterprise polish.

**The backend thread retains:** OBS-4 cutover (after ADMIN-8 only) · TD130 · the 13-field
audit record · production hardening · security improvements · ADR maintenance · tech-debt
reduction · architecture consistency · repository health · final production readiness ·
infrastructure. **No UI work happens there. No backend redesign happens here.**

**The handback rule.** This thread must never work around backend behaviour. A backend
issue found mid-build is documented with reproducible evidence — request, response, log
line, step — and returned to the backend thread. That is invariant #9 in
[CLAUDE.md](../../CLAUDE.md): *frontend code never compensates for backend inconsistencies.*

---

## 8. Success criteria before OBS-4 (owner-set)

The legacy ops console is retired only when **all sixteen** hold:

Admin Portal feature-complete · backend API coverage complete · authentication verified ·
RBAC verified · capability matrix verified · audit verified · events verified · finance
verified · worker management verified · company management verified · agency management
verified · responsive UX verified · accessibility verified · performance verified ·
security review passed · production-readiness checklist complete.

Until then `apps/web` keeps running untouched — that is what makes the cutover a traffic
switch instead of a rewrite.

---

## 9. First actions for the fresh thread

1. Read this file, [ADR-0025](../decisions/0025-admin-ops-portal.md) and [ADR-0038](../decisions/0038-admin-bootstrap-and-notification-layer.md).
2. **Run the mandatory foundation gate — before any React.**
   [docs/admin-foundation-verification-runbook.md](../admin-foundation-verification-runbook.md)
   walks the owner's 13 steps as executable commands on a database created from empty. Verify
   the foundation rather than trusting this document. Any failure is a **backend defect**:
   stop, file it with evidence, do not work around it.
3. Scaffold `apps/admin-web` (decided — §6).
4. Build Phase 1. It needs no backend work, so it is the cleanest possible proof that the
   foundation holds.

### Two gate defects were found and fixed before handoff (backend thread, 2026-08-03)

Running the gate on paper surfaced two things that would each have cost this thread a day:

- **`GET /admin/me` returned only `{admin_id, role}`** — no capabilities. `ADMIN_CAPABILITY_MATRIX`
  lives inside `apps/api`, so a sibling app cannot import it, and the portal's only options
  were to hardcode the role lists or guess. `/admin/me` now returns a server-resolved
  `capabilities` array, derived through `can()` so it cannot drift from what the guards
  enforce. **Render against this; never ship a second copy of the matrix.**
- **There was no local email path at all.** `EMAIL_PROVIDER` is real-only by design, so admin
  login codes had nowhere to go on a dev machine — and `PAYER_LOGIN_METHOD=whatsapp` only
  dodges the boot guard, leaving the send to fail opaquely later. A profile-gated Mailpit
  service (`pnpm mail:up`) now gives the real `EMAIL_PROVIDER=smtp` path a real local
  destination.
