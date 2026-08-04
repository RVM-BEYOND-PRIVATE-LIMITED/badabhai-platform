# BadaBhai Backlog — organized by owner thread

**Single source of truth for all remaining workstreams.** Created 2026-08-03 when the backend
stabilization thread entered Platform Maintenance Mode. Every open work item belongs to
**exactly one** thread. If you are about to start work, find it here first — if it is not in
your thread, it is not yours.

**Built from the repository, not from a session TODO list.** Sources: the 132-row
[tech-debt register](../registers/tech-debt-register.md) (103 open), [BLOCKERS.md](BLOCKERS.md),
[OWNER_TASKS.md](OWNER_TASKS.md), the [ADMIN-4..8 brief](../sprint-plans/admin-portal-admin-4-to-8.md),
and CLAUDE.md §8. Ownership was assigned programmatically and asserted: **0 orphans,
0 multi-owner items, 0 assigned-but-closed** (§7).

---

## 0. Two structural findings you should read before the tables

**(a) A fifth thread was required.** The four requested threads have no home for *active*
worker-app / payer-web / AI-quality product debt — 18 open items such as TD119 (57 of 259
answer chips resolve the wrong topic, measured), TD102 (a worker's ITI can never reach their
résumé) and TD73 (`GET /feed` must exclude decided jobs server-side, ruled MANDATORY before
real job volume). These are neither platform work nor "future nice-to-have", so filing them
in either place would be a lie that loses them. They are collected in **Thread 5 — Product
Streams**, which is *not new work*: it is the existing worker-app / payer-web streams the
owner already referred to as "their respective product thread". Rename or split it freely;
do not empty it into Thread 4.

**(b) Phase 2 of the portal plan is backend work, and it stays in Thread 2.** The brief's
Phase 2 needs **additive admin-guarded read endpoints** (workers, companies, agencies, jobs,
applications, credits, transactions) — none exist today; those reads live only behind
`InternalServiceGuard`. That is new backend code, so under the rule *"Thread 1 has no backend
work"* it is filed as **BP-1** and Thread 1 **depends** on it. This is the single
cross-thread dependency in the plan and the most likely place for the portal to stall.

---

## 1. Thread registry

| Thread | Name | Mode | Owns |
|---|---|---|---|
| **T1** | **Admin Portal** | **ACTIVE — critical path** | `apps/admin-web`, ADMIN-4..8, all portal UI/UX/a11y, portal verification |
| **T2** | **Backend Platform** | Maintenance (**frozen after this doc**) | Audit record, TD130, OBS-4, readiness deliverables, security hardening, ADR maintenance, backend tech debt |
| **T3** | **Infrastructure & DevOps** | Maintenance | CI/CD, Docker, deploy pipelines, secrets/env, security tooling, monitoring, health checks |
| **T4** | **Future Product** | Deferred — **must not block alpha** | Admin Portal v2, analytics, advanced reporting, real-money modules, future automation |
| **T5** | **Product Streams** | Active (pre-existing) | worker-app, payer-web, AI extraction quality |

---

## 2. THREAD 1 — Admin Portal (ACTIVE)

> No backend remediation. A backend defect found here is **documented with reproducible
> evidence and handed to T2** — never worked around in UI (CLAUDE.md invariant #9).

### AP-1 — Foundation verification on a clean environment

| Field | Value |
|---|---|
| **ID / Title** | AP-1 — 13-step clean-bootstrap verification |
| **Owner** | T1 |
| **Priority** | **P0** |
| **Status** | **Ready** |
| **Dependencies** | None (all blockers cleared: migrations `0062`/`0063` applied 2026-08-03; the two gate defects fixed in #565) |
| **Entry criteria** | A machine with Docker. Nothing else. |
| **Exit criteria** | All 13 steps observed on a database created by `docker compose down -v`. Specifically: bootstrap refuses on a second run and exits 0; the logged-out token returns **401**; a re-login returns `needs_enrollment: false`; `/admin/me` returns the 9 super_admin capabilities; `admin.session_started` + `admin.session_revoked` are in `GET /admin/events` with **no** email/code/secret in any payload. |
| **Deliverables** | A signed record in [QA_EVIDENCE.md](QA_EVIDENCE.md): date, commit SHA, per-step outcome. Captured artifacts under `docs/qa/evidence/`. |
| **Verification** | Executed, not reasoned. [The runbook](../admin-foundation-verification-runbook.md). |

> **This is the gate. No React until it passes.** On any failure: stop, classify as a backend
> defect, hand to T2, update the runbook, resume only after it passes unchanged.

### AP-2 — ADMIN-4: `apps/admin-web` + shell, auth, dashboard

| Field | Value |
|---|---|
| **Owner / Priority / Status** | T1 · **P0** · Not Started |
| **Dependencies** | **AP-1** |
| **Entry criteria** | AP-1 PASS recorded. |
| **Exit criteria** | A real admin logs in through the UI (email OTP → TOTP → session), sees a dashboard on `GET /admin/events` + `/events/metrics`, navigates the sidebar, refreshes across a reload, and logs out. **Needs no new backend.** |
| **Deliverables** | `apps/admin-web` scaffold + CI wiring; login, MFA-enrolment (QR + otpauth URI) and session/refresh/logout; app shell + nav; dashboard; live event feed; system health. |
| **Verification** | Per-module gate (§2 tail) + mutation tests on the session-expiry and capability-hiding branches. |

### AP-3 — ADMIN-5: Workers · Companies · Agencies

| Field | Value |
|---|---|
| **Owner / Priority / Status** | T1 · P1 · **Blocked** |
| **Dependencies** | AP-2, **BP-1** (admin-guarded read endpoints) |
| **Entry criteria** | BP-1 endpoints merged and callable with an admin session. |
| **Exit criteria** | List + detail + search + filter + pagination for each; every privileged action (suspend / reinstate / flag / unflag / reveal-contact) shows its resulting event. Worker contact detail appears **only** via `POST /admin/workers/:id/reveal-contact`. |
| **Deliverables** | Three modules against the design system, with role-aware controls driven by `/admin/me` capabilities. |
| **Verification** | Per-module gate, **including the denied roles** — an `analyst` must not see suspend; an `ops_admin` must not see reveal-contact. |

### AP-4 — ADMIN-6: Jobs · Applications · Finance · Credits

| Field | Value |
|---|---|
| **Owner / Priority / Status** | T1 · P1 · **Blocked** |
| **Dependencies** | AP-3, BP-1 |
| **Entry criteria** | AP-3 complete; finance/credit read endpoints available. |
| **Exit criteria** | Job postings (incl. the ADR-0037 `suspended` state rendered as a *system* state, not user-set), applications, credit ledger and transactions are all viewable; grant-credits and force-close work and show their events. |
| **Deliverables** | Four modules + a money-formatting primitive honouring the ₹ rules in the design system. |
| **Verification** | Per-module gate + a suspended-payer fixture proving suspended inventory is visibly distinguished from closed. |

### AP-5 — ADMIN-7: Audit · Events · Reports · Configuration

| Field | Value |
|---|---|
| **Owner / Priority / Status** | T1 · P1 · **Blocked** |
| **Dependencies** | AP-4 |
| **Entry criteria** | AP-4 complete. |
| **Exit criteria** | Audit + events viewers with filter, keyset pagination, correlation-trace and export (`export` capability only — **not** `support`). Audit is built against a narrow `listAuditEntries(query)` seam with the events API as its first implementation, so BP-2 later is a **swap, not a redesign**. |
| **Deliverables** | Four modules + the documented data-source seam. |
| **Verification** | Per-module gate + a proof the seam can be re-pointed (a second stub implementation compiles and renders). |

### AP-6 — ADMIN-8: Admin management, responsive, accessibility, polish

| Field | Value |
|---|---|
| **Owner / Priority / Status** | T1 · P1 · **Blocked** |
| **Dependencies** | AP-5 |
| **Entry criteria** | AP-5 complete. |
| **Exit criteria** | Admin invite/role/suspend/**MFA-reset** UI (`manage_admins`, super_admin only; self-reset must be refused **by the UI as well as the server**). Responsive to mobile. Keyboard-navigable, screen-reader labelled, contrast-checked. No RVMCAD branding, no placeholder UI, no developer tooling exposed. |
| **Deliverables** | Admin-management module + a11y + responsive pass across every module. |
| **Verification** | Per-module gate + an a11y audit with findings recorded, not just "checked". |

### AP-7 — Portal verification (workstream Definition of DONE)

| Field | Value |
|---|---|
| **Owner / Priority / Status** | T1 · **P0** · Not Started |
| **Dependencies** | AP-6 |
| **Entry criteria** | All modules feature-complete. |
| **Exit criteria** | All ten points of the [CLAUDE.md §6 Definition of DONE](../../CLAUDE.md) hold — including **clean-environment verification** (the portal comes up from an empty DB via the runbook) and **mutation testing** with any survivor reported. |
| **Deliverables** | Verification report; the 16 OBS-4 criteria evidenced one by one. |
| **Verification** | Independent review; no self-certification. |

**Per-module gate** (every AP module): API · permissions incl. denied roles · audit · events ·
pagination · search · filters · responsive · accessibility · performance · error states ·
loading states · security.

---

## 3. THREAD 2 — Backend Platform (Maintenance; frozen after this doc)

> No UI work. Frozen means: nothing new enters except portal-unblocking or production-critical.

| ID | Title | Pri | Status | Depends on | Entry criteria | Exit criteria / Deliverable | Verification |
|---|---|---|---|---|---|---|---|
| **BP-1** | **Additive admin-guarded read endpoints** (workers, companies, agencies, jobs, applications, credits, transactions) | **P0** | **Ready** | AP-1 pass | Foundation proven | New `@UseGuards(AdminAuthGuard, AdminRolesGuard)` read routes **alongside** the internal ones. **Do NOT widen an `InternalServiceGuard` route** — a guard union is the fail-open shape this codebase avoids. Ops console untouched. | Authz tests per route incl. denied roles; mutation on the capability decorator |
| **BP-2** | **13-field audit record** — `audit_logs` has **zero writers** today | P1 | Not Started | AP-5 seam exists | Portal Audit view built on the seam | Actor · role · capability · reason · target · timestamp · IP · session · correlation id · before · after · result · failure reason. Behind `listAuditEntries(query)` so the UI swaps, not redesigns | Write-path tests + a mutation proving a missing field fails |
| **BP-3** | **TD130 — auth timing equalization** | P1 | **Waiting** | ADMIN-8 | Portal complete (owner sequencing) | Constant-time floor across `signup` + `requestLogin` + `verifyLogin` together — a floor on one branch only moves the oracle. **Measure first; no arbitrary sleeps** | Measured latency distributions, known vs unknown vs suspended |
| **BP-4** | **OBS-4 — retire the legacy ops console** | P1 | **Waiting** | AP-7 + all 16 criteria | Every one of the 16 met | Traffic switch to `apps/admin-web`; `apps/web` retired only after parity is proven | Parity checklist; rollback rehearsed |
| **BP-5** | Architecture Consistency Report | P2 | Not Started | BP-1..BP-4 | Portal verified | Duplicate-logic audit, ADR compliance, RBAC consistency, API + event consistency | Review |
| **BP-6** | Security Validation Report | P1 | Not Started | AP-7 | Portal verified | Full PII/authz/DPDP posture incl. the admin surface | `bb-security-review` + independent pass |
| **BP-7** | Production Readiness Report + checklist | **P0** | Not Started | BP-5, BP-6, T3 items | Infra green | The release gate document | Owner sign-off |
| **BP-8** | Tech-debt triage into P0/P1/P2 | P2 | Not Started | — | Anytime | Every open TD carries a priority (this doc assigns *ownership*; it does not re-prioritise 103 items) | Register updated |
| **BP-9** | Consolidated Operational Runbook | P1 | Not Started | — | Anytime | Merge the existing runbooks into one operator entry point | Dry-run by someone who did not write it |
| **BP-10** | **Disaster Recovery & Rollback plan** — *does not exist* | **P0** | Not Started | — | Anytime | Backup/restore, RPO/RTO, data-loss drill. Named as still-pending in CLAUDE.md §8 | A **rehearsed** restore, not a written one |
| **BP-11** | **Cost strategy doc** — named pending in CLAUDE.md §8 | P2 | Not Started | — | Anytime | AI + infra unit economics vs the §3A ≤₹4/profile target | Owner review |
| **BP-12** | Roadmap v2 document (the *plan* for Admin Portal v2) | P2 | Not Started | AP-7 | Portal verified | Document only — the **work** is T4 | Owner review |

**Backend Platform tech debt — 41 open items** (detail in the register; not duplicated here):
`TD1 TD3 TD4 TD8 TD9 TD12 TD14 TD15 TD19 TD20 TD21 TD22 TD24 TD25 TD33 TD35 TD38 TD44 TD48
TD50 TD55 TD57 TD69 TD70 TD74 TD77 TD79 TD80 TD83 TD88 TD91 TD92 TD93 TD95 TD99 TD100 TD104
TD124 TD125 TD128 TD130`

Highest-signal of those: **TD4** (RLS not enforced platform-wide — backend still runs as the
service role), **TD69** (consent-withdrawal ⇒ session-revocation is an untested invariant,
owner-ACTIVATED), **TD130** (= BP-3), **TD125** (registers drift open behind shipped fixes —
three instances in one week).

---

## 4. THREAD 3 — Infrastructure & DevOps

| ID | Title | Pri | Status | Depends on | Entry / Exit | Verification |
|---|---|---|---|---|---|---|
| **INF-1** | **TD131 — deterministic security tooling** | **P0** | **Ready** | — | Pin semgrep **and** its rulesets (vendor or digest-pin); reproduce locally with CI's exact command; document an update cadence; then clear or explicitly accept the 26 standing findings | Same commit scanned twice on different days → identical result |
| **INF-2** | **TD123 — the staging CD pipeline has never run** | **P0** | **Ready** | — | Staging exists only as a manual deploy. Exit: a green automated deploy, twice | A deploy nobody performed by hand |
| **INF-3** | **TD81 — ai-service is not deployed; staging silently runs mocked AI behind a 200 `/health`** | **P0** | **Ready** | — | Deploy it, **or** make the mock loud in `/health`. Today any "real profiling verified on staging" claim is false | `/health` distinguishes real from mock |
| **INF-4** | **TD52 — staging runs `NODE_ENV=development`** (fail-closed boot asserts disabled, permissive CORS) | **P0** | **Ready** | — | Staging runs production-mode asserts | Boot-assert test on the box |
| **INF-5** | **TD10 — no secrets manager** | P1 | Not Started | — | Managed secrets + rotation story; today secrets are env-file bound | Rotation rehearsed |
| **INF-6** | **TD129 — the e2e job cannot run any worker-touching flow** (`permission denied for table workers/events`) | P1 | Not Started | Security decision | The whole worker journey is currently unexercised in CI. **A security-boundary decision (ADR-0004/TD4), not a test change** | 8 suites green + the skipped onboarding test un-skipped |
| **INF-7** | **TD97 — the Supabase schema↔migrations drift gate is `disabled_manually`** | P1 | Not Started | — | Re-enable, or record why not | Gate runs on PRs |
| **INF-8** | TD96 — deploy held on `ssh-action` v1.0.3 (later versions defeat the SHA pin; the step carries 12 production secrets) | P1 | **Deferred (ruled)** | — | Revisit only with an owner decision | — |
| **INF-9** | **TD132 — require genuine peer review before public beta**; `--admin` becomes the exception | P1 | **Deferred (time-boxed)** | Team size | Branch protection enforced; bypass recorded when used | Protection settings + merge log |
| **INF-10** | Email infrastructure for staging/production (ZeptoMail creds, from-identity, deliverability) | P1 | Not Started | — | Local is solved (Mailpit, `pnpm mail:up`, #565). Staging/prod admin + payer email is not | A real admin login on staging |
| **INF-11** | Monitoring / logging / alerting for the admin surface | P2 | Not Started | AP-2 | Admin auth failures and MFA resets are alertable | Alert fires in a drill |

**Infrastructure tech debt — 18 open items:**
`TD2 TD10 TD52 TD67 TD71 TD72 TD76 TD81 TD96 TD97 TD109 TD118 TD122 TD123 TD126 TD129 TD131 TD132`

---

## 5. THREAD 4 — Future Product (Deferred — must not block alpha)

| ID | Title | Pri | Status |
|---|---|---|---|
| FP-1 | Admin Portal v2 (saved views, bulk actions, richer analytics) | P2 | **Deferred** |
| FP-2 | Advanced reporting + analytics | P2 | **Deferred** |
| FP-3 | Future audit enhancements beyond the 13-field record | P2 | **Deferred** |
| FP-4 | **Real-money finance modules** — real credit-pack purchase (TD34), agency payouts live (TD39) | P2 | **Deferred — launch-gated, ADR-signed** |
| FP-5 | Reach/ranking beyond RANK v1 — learned ranking, boost ranking (TD42) | P2 | **Deferred — invariant #4 holds** |
| FP-6 | Future automation (growth loop, retag runners at scale) | P2 | **Deferred — human-gated** |

**Future-product tech debt — 26 open items:**
`TD34 TD36 TD37 TD39 TD40 TD42 TD43 TD45 TD46 TD47 TD51 TD58 TD64 TD65 TD86 TD87 TD89 TD90
TD107 TD108 TD112 TD113 TD114 TD116 TD117 TD127`

> **Deferred means deferred.** Nothing here may be pulled forward into T1/T2/T3 without an
> owner decision recorded in [DECISION_LOG.md](DECISION_LOG.md).

---

## 6. THREAD 5 — Product Streams (active; pre-existing, see §0a)

Owners: **Rishi** (worker-app / payer-app), **Divyanshu** (payer-web / AI). Not opened by the
backend thread; listed so these items are not orphaned.

**Product-stream tech debt — 18 open items:**
`TD5 TD6 TD17 TD26 TD29 TD54 TD59 TD63 TD66 TD73 TD94 TD98 TD101 TD102 TD103 TD111 TD119 TD121`

Highest-signal: **TD73** (`GET /feed` must exclude decided jobs server-side — ruled
**MANDATORY before real job volume**), **TD119** (57 of 259 answer chips resolve the wrong
topic — measured, not estimated), **TD102** (a worker's ITI can never reach their résumé),
**TD29** (worker-app alpha flows incomplete).

---

## 7. Dependency graph

```
                        ┌─────────────────────────────────────────┐
                        │ PLATFORM (done 2026-08-03)              │
                        │ ADR-0037 lifecycle · ADR-0038 bootstrap │
                        │ email pipeline · MFA recovery           │
                        │ migrations 0062+0063 APPLIED            │
                        └────────────────────┬────────────────────┘
                                             ↓
                              ┌──────────────────────────┐
                              │ AP-1  FOUNDATION GATE    │  ◀── THE gate. P0. Ready.
                              │ 13 steps, empty database │
                              └──────────────┬───────────┘
                                  PASS ──────┴────── FAIL ──▶ back to T2 as a defect
                                             ↓
                              ┌──────────────────────────┐
                              │ AP-2  ADMIN-4            │   (needs no backend)
                              │ shell · login · MFA      │
                              │ nav · dashboard · health │
                              └──────────────┬───────────┘
                                             ↓
        ┌────────────────────────────────────┴─────────┐
        │ BP-1 admin-guarded READ endpoints  (T2, P0)  │ ◀── the one cross-thread dependency
        └────────────────────────────────────┬─────────┘
                                             ↓
                    AP-3 ADMIN-5  Workers · Companies · Agencies
                                             ↓
                    AP-4 ADMIN-6  Jobs · Applications · Finance · Credits
                                             ↓
                    AP-5 ADMIN-7  Audit · Events · Reports · Config
                                             │
                                             ├──▶ BP-2  13-field audit record
                                             │          (swaps in behind the seam)
                                             ↓
                    AP-6 ADMIN-8  Admin mgmt · responsive · a11y · polish
                                             ↓
                    AP-7 PORTAL VERIFICATION (10-point DoD + 16 criteria)
                                             ↓
                             ┌───────────────┴───────────────┐
                             │ BP-3 TD130 timing equalization│ (owner: after ADMIN-8)
                             └───────────────┬───────────────┘
                                             ↓
                              BP-4  OBS-4 CUTOVER (retire apps/web)
                                             ↓
                    BP-7 PRODUCTION READINESS  ◀── also requires:
                                             │     BP-5 architecture · BP-6 security
                                             │     BP-10 DR/rollback · BP-9 runbook
                                             │     INF-1..INF-4 (all P0)
                                             ↓
                                        RELEASE

RUNS IN PARALLEL, blocks RELEASE but not the portal:
    T3  INF-1 semgrep · INF-2 staging CD · INF-3 ai-service · INF-4 NODE_ENV
        INF-5 secrets · INF-6 e2e worker flows · INF-7 drift gate · INF-10 email
    T2  BP-8 TD triage · BP-9 runbook · BP-10 DR · BP-11 cost · 41 TD items
    T5  worker-app / payer-web / AI-quality (18 TD items) — TD73 before real job volume

NEVER BLOCKS ALPHA:
    T4  FP-1..FP-6 + 26 TD items — deferred by decision
```

---

## 8. Project health

### Counts

| Priority | Count | Where |
|---|---|---|
| **P0** | **10** | AP-1 · AP-2 · AP-7 · BP-1 · BP-7 · BP-10 · INF-1 · INF-2 · INF-3 · INF-4 |
| **P1** | **15** | AP-3 · AP-4 · AP-5 · AP-6 · BP-2 · BP-3 · BP-4 · BP-6 · BP-9 · INF-5 · INF-6 · INF-7 · INF-8 · INF-9 · INF-10 |
| **P2** | **11** | BP-5 · BP-8 · BP-11 · BP-12 · INF-11 · FP-1..FP-6 (all deferred) |
| **Named tasks** | **36** | T1 7 · T2 12 · T3 11 · T4 6 |
| **Open TD** | **103** | T2 41 · T3 18 · T4 26 · T5 18 |

### Critical blockers

1. **AP-1 has not been run.** 15 PRs read as "the foundation works"; under invariant #10 it is
   **not proven** until it reproduces from an empty database. Everything in T1 sits behind it.
2. **BP-1 does not exist.** No admin-guarded list/detail endpoint exists for any core entity.
   AP-3 onward are blocked the moment AP-2 finishes — start BP-1 **during** AP-2, not after.
3. **Staging is not trustworthy** (INF-2/3/4): the CD pipeline has never run, the ai-service is
   absent while `/health` reports 200, and the box runs `NODE_ENV=development` with
   fail-closed boot asserts **disabled**. No production-readiness claim can rest on it today.
4. **No disaster-recovery plan exists** (BP-10). Named as pending in CLAUDE.md §8 and never written.

### Risks

| Risk | Why it bites | Mitigation |
|---|---|---|
| Portal builds against the wrong audit shape | BP-2 lands after AP-5 | The `listAuditEntries` seam is mandatory in AP-5's exit criteria |
| Someone widens `InternalServiceGuard` to save time on BP-1 | Undoes the LC-1 hardening; a guard union is fail-open | Called out in BP-1; make it a review checkpoint |
| The UI re-implements the capability matrix | Two authorization tables drift | `/admin/me` capabilities shipped in #565; guardrail in the brief |
| `docs/qa/evidence/staging/` is still empty | Verification is team attestation, not artifacts | AP-1 captures artifacts as a deliverable |
| SAST stays red (INF-1) | An always-red check trains everyone to ignore it | P0 |

### Completion — by remaining engineering effort and *verified* completion

> Method: effort-weighted against remaining scope, **not** commits. The tracker's cap rule
> applies — **no area exceeds 85%** while `docs/qa/evidence/staging/` is empty and staging is
> in the INF-2/3/4 state. These are engineering estimates, not measurements.

| Area | Complete | Reasoning |
|---|---|---|
| **Backend Platform** | **~78%** | Admin identity/RBAC/MFA/bootstrap/email, payer lifecycle and the event spine are built and test-verified. Remaining: BP-1, the audit record, TD130, OBS-4, DR, and 41 TD items. Capped: none of it is verified on a trustworthy deployed environment. |
| **Admin Portal** | **~6%** | Groundwork only — brief, phase order, runbook, `/admin/me` capabilities, local email. **Zero UI exists.** AP-1 has not been run. |
| **Infrastructure** | **~45%** | Docker/compose, CI gates, staging box and observability runbooks exist. But CD has never run, ai-service is undeployed, staging is in dev mode, secrets are unmanaged, SAST is nondeterministic. |
| **Product Streams** | ~70% | Worker journey + payer portal are built and partially handset-verified; 18 open items, several measured-and-material. |
| **OVERALL** | **~55%** | Weighted: platform 30% · portal 25% · infra 25% · product 20%. The portal being ~0% and infra being half-done are what hold this down — not backend feature work, which is essentially finished. |

### Recommended execution order

1. **AP-1** — today. One person, ~15 minutes. It either unblocks everything or produces the
   most valuable bug report available right now.
2. **AP-2 ∥ BP-1 ∥ INF-1..INF-4** — the portal shell needs no backend, so run all three in
   parallel. BP-1 must land before AP-2 finishes or AP-3 stalls.
3. **AP-3 → AP-4 → AP-5** (+ BP-2 behind the seam) → **AP-6** → **AP-7**.
4. **BP-3** (TD130), then **BP-4** (OBS-4) once all 16 criteria hold.
5. **BP-5/6/7/9/10** — readiness. **BP-10 (DR) is P0 and has no dependencies: start it now**,
   in parallel with everything above.
6. **T4** — after release. **T5** runs continuously in its own thread; TD73 before real job volume.

### Phases

| Phase | Content | Gate to exit |
|---|---|---|
| **0** | AP-1 | 13/13 observed on an empty DB |
| **1** | AP-2 ∥ BP-1 ∥ INF-1..4 | Admin logs in through the UI; staging trustworthy |
| **2** | AP-3 → AP-4 → AP-5 (+BP-2) | Modules pass the per-module gate |
| **3** | AP-6 → AP-7 | 10-point DoD + 16 OBS-4 criteria |
| **4** | BP-3 → BP-4 | Ops console retired on proven parity |
| **5** | BP-5/6/7/9/10 + INF-5..11 | Production Readiness signed |

---

## 9. Final requirement checklist

| # | Requirement | Result |
|---|---|---|
| 1 | Every remaining task has an owner | ✅ 103 TD + 36 named tasks, each in exactly one thread |
| 2 | No orphan tasks | ✅ **verified programmatically** — `orphans: NONE` |
| 3 | No duplicated tasks | ✅ `multi-owner overlap: NONE`; TD detail is **referenced**, never restated |
| 4 | No UI work in Backend Platform | ✅ T2 holds no UI. BP-1 is a backend *endpoint*, consumed by T1 |
| 5 | No backend work in Admin Portal | ✅ Phase-2 endpoints moved out to **BP-1**; T1 hands defects back rather than fixing them |
| 6 | All deferred work explicitly marked | ✅ T4 (6 items + 26 TD) marked **Deferred**; INF-8/INF-9 marked deferred with the ruling |
| 7 | Backend Platform backlog frozen | ✅ **Frozen 2026-08-03.** New T2 entries require an owner decision in DECISION_LOG.md |

**Two honest caveats.** (a) Thread 5 exists because the four requested threads could not hold
active product debt without mislabelling it — see §0a. (b) This document assigns **ownership**;
it does not re-prioritise all 103 TD items into P0/P1/P2 — that is BP-8, and doing it here
would mean inventing priorities for items I have not re-verified.

---

**Backend Platform backlog FROZEN 2026-08-03.** Changes require an owner decision recorded in
[DECISION_LOG.md](DECISION_LOG.md). Task detail lives in the
[tech-debt register](../registers/tech-debt-register.md); this file owns *who* and *when*.
