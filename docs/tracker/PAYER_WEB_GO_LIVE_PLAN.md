# Payer-Web (Company + Agency) Go-Live Plan

> Goal: make `apps/payer-web` fully functional end-to-end against the real backend on **staging**, with real money/providers OFF (mock payments, mock WhatsApp, real email-OTP only). Scope: ADR-0019 (Employer self-serve) + ADR-0022 (Agency supply). Evidence: verified endpoint extraction across payer-auth, job-postings, posting-plans/capacity, applicant-feed, agency, payer-web-wiring, and cross-cutting areas (+ a dedicated re-verification of the unlock/reveal/credits/disclosure surface, 2026-06-29).
>
> Companion doc for the Android dev: [../api/payer-agency-api-reference.md](../api/payer-agency-api-reference.md).

---

## 1. Summary — LIVE vs Blocking "All Features Working"

**Already LIVE (backend wired + payer-web caller exists, real session-authed):**

- **Auth + identity** — signup, login/request, login/verify, refresh, logout, `GET /payer/me` are all LIVE and IDOR-proof (session-derived `payer_id`, no enumeration oracle, real email-OTP via ZeptoMail).
- **Employer job postings** — create / list / get / edit-publish / close are LIVE and payer-authed (`/payer/job-postings/*`), horizontal-authz enforced.
- **Applicant feed (faceless reach)** — `GET /payer/reach/jobs/:jobId/applicants` LIVE, faceless, rate-limited, no-oracle 404.
- **Contact Unlock + Reveal** — `POST /payer/unlocks`, `POST /payer/unlocks/:id/reveal`, `GET /payer/unlocks`, `GET /payer/credits`, `POST /payer/credits` (mock money) all LIVE and wired. (Reveal emits `contact.revealed`; deny paths emit `unlock.denied`/`unlock.cap_exceeded`/`payment.failed` — verified.)
- **Capacity** — `GET /payer/capacity` + `POST /payer/capacity` LIVE, session-authed, mock payment, enforcement INERT by default.
- **Agency** — jobs (create/list/get/edit/close/pause), invite mint, referrals summary (k-anon) all LIVE, agent-role-guarded, wired in payer-web.
- **Masked-resume disclosure backend** — `POST /payer/resume-disclosures` + `GET /payer/resume-disclosures` are LIVE and payer-authed (free, no credit debit; emits `resume.disclosed`) — **but payer-web still calls a MOCK shim.**

**What blocks "all features working" (the real gap set):**

1. **Money routes are unguarded (IDOR / LC-1):** `POST /job-postings/:id/plan` and `POST /job-postings/:id/boost` trust body `payer_id`, no guard. payer-web cannot safely call them — no payer-authed buy-plan/boost route exists. Employer plan/boost purchase is **unavailable**.
2. **Posting pause/resume/quota-topup are MOCK-only** for **company** postings — backend `job_postings` has no `paused` state and no quota column/route. payer-web functions hit the mock store.
3. **Masked-resume reveal in payer-web is a MOCK shim** even though the live payer-authed endpoint exists — pure wiring swap pending.
4. **Org-member / Team-RBAC is a STUB** — no backend `/payer/org/members` API; payer-web functions return `[]`/neutral error. (Phase-2 deferred per CLAUDE.md §8.)
5. **Credit ledger / spend history is synthesized client-side** (live balance + live unlock spends + mock top-ups) — no authoritative credit-ledger read endpoint.
6. **Account self-edit (PATCH /payer/me) is LIVE but not wired** in payer-web (PROFILE/PROF-3 deferred slice).
7. **Mobile auth contract gap:** `PayerAuthGuard` reads **only** `Authorization: Bearer`; rolling token comes in the **response body** (`access_token`), not a request header. Android must store the body token — this is a contract-clarity item for Rishi (Flutter), not a payer-web blocker.
8. **Posting demand-parity fields** (trade/pay/exp) collected by payer-web but **not yet accepted** by `PayerCreateJobPostingSchema` — withheld client-side until backend schema grows (Phase-2).

For staging "fully live," the must-do set is **1, 2, 3** (functional gaps users hit) plus **6** (account edit). Items **4, 5, 8** are explicitly Phase-2 / low-impact and can ship as honest "coming soon" states. Item **7** is a mobile note only.

---

## 2. Gap List

| # | Gap (mock / stub / missing / auth) | Type | Evidence | What it blocks | Fix |
|---|---|---|---|---|---|
| G1 | `POST /job-postings/:id/plan` unguarded, trusts body `payer_id` | auth-gap / IDOR / LC-1 | posting-plans.controller.ts:16-24 (no `@UseGuards`) | Employer buying a posting plan tier (visibility/quota window) | Add payer-authed `POST /payer/job-postings/:id/plan` (PayerAuthGuard, `@CurrentPayer`, ownership in WHERE); deprecate unguarded route or guard it |
| G2 | `POST /job-postings/:id/boost` unguarded, trusts body `payer_id` | auth-gap / IDOR / LC-1 | posting-plans.controller.ts:26-34 | Employer boosting a posting in ranking feed | Add payer-authed `POST /payer/job-postings/:id/boost` (same pattern as G1) |
| G3 | `POST /payers/:payerId/capacity` `:payerId` is ADVISORY (InternalServiceGuard only) | auth-gap / LC-1 | capacity.controller.ts:20-34 | (ops route) cross-payer capacity write possible by token holder | Keep ops route behind internal token; payer-self route `POST /payer/capacity` already correct — no payer-web change |
| G4 | `pausePosting()` / `resumePosting()` (company postings) read/write mock store | mock-only | payer-api.ts:729,742; mock-store.ts; schema has only draft/open/closed | Company posting PAUSE/RESUME UI is non-functional | Backend: add `POST /payer/job-postings/:id/pause` + `/resume` + a `paused` lifecycle state (versioned, backward-compat); then wire payer-web |
| G5 | `topUpPostingQuota()` reads/writes mock store; no quota column/route | mock-only | payer-api.ts:757; live posting projection has no quota field | "View more applicants" / per-posting quota top-up | Backend: add `POST /payer/job-postings/:id/quota` + counter/pricing integration; wire payer-web |
| G6 | `revealMaskedResume()` returns MOCK PDF URL + mock initials | mock-only (backend LIVE) | payer-api.ts:704-718 vs LIVE payer-disclosure.controller.ts:52-64 | Masked-resume PDF reveal after unlock | **Pure wiring swap** — point `revealMaskedResume` at `POST /payer/resume-disclosures` |
| G7 | Org-member API absent; `listOrgMembers/inviteOrgMember/removeOrgMember` are STUBs | stub / missing-endpoint | org-members.ts (returns `[]`/neutral err); no backend route | Team / owner-vs-recruiter RBAC | Backend: `POST/GET/DELETE /payer/org/members` (session-scoped). **Phase-2 per CLAUDE.md §8** — ship "coming soon" |
| G8 | `getCreditTopUps()` reads mock store; history synthesized client-side | mock-only | payer-api.ts:273; credit-history.ts merges live unlocks + mock top-ups | Credit spend history / 12-month expiry schedule UI | Backend: `GET /payer/credits/ledger` (payer-scoped). Low-impact (balance is live) |
| G9 | `PATCH /payer/me` LIVE but **not wired** in payer-web | other (wiring) | payer-account.controller.ts:42-50; "Not yet wired (PROF-3 deferred)" | Account edit (org name / phone) | **Pure wiring** — call `PATCH /payer/me` from account page |
| G10 | Posting applicant-quota field absent from live posting projection | mock-only | contracts.ts:28-32 (mock); live rows have no quota | Per-posting quota display (renders "–" for live rows) | Tied to G5; render honest "–" until quota route lands |
| G11 | Demand-parity fields (tradeKey/payMin/payMax/exp) not accepted by `PayerCreateJobPostingSchema` | contract-mismatch | payer-api.ts comment; PayerCreateJobPostingSchema lacks them | Employer demand parity w/ agency jobs | Backend: expand DTO + store on jobs table (Phase-2, ADR-0022 expansion) |
| G12 | `is_new_payer` hardcoded `false` at verify | contract-mismatch | payer-auth.service.ts:140 | "new payer" onboarding branch never triggers | Either remove field or plumb signup→verify created flag. Low-impact; don't branch UI on it |
| G13 | Mobile rolling token only in response body, not a request header | contract-mismatch | payer-auth.guard.ts:113-119 (reads only `Authorization: Bearer`) | Android payer app auth | Doc/contract clarity for Rishi (Flutter); payer-web unaffected (httpOnly cookie) |
| G14 | Real payments OFF (`PAYMENTS_ENABLE_REAL=false`), real WhatsApp OFF | mock-only (intended) | all credit/capacity/plan flows `real_call:false`; ADR-0020 mock | Production revenue / real invite send | **Stays OFF for staging.** Real money is §7-gated; not a go-live blocker |
| G15 | No pagination on list endpoints (limit ≤500, no offset/totalCount) | other | cross-cutting notes | Large payer lists (>500 postings) | Phase-2 pagination; not a staging blocker |

---

## 3. Backend Work Needed (ordered)

1. **[P0 / LC-1] Payer-authed posting-plan + boost routes** — `POST /payer/job-postings/:id/plan` and `POST /payer/job-postings/:id/boost` (PayerAuthGuard, `@CurrentPayer`, ownership in WHERE, body carries **no** `payer_id`, tier/coupon only). Mirrors the correct `POST /payer/capacity` pattern. Closes G1/G2 (TD33/LC-1). Guard or deprecate the unguarded `/job-postings/:id/plan|boost`. **Owner: Divyanshu.**
2. **[P0] Company posting pause/resume lifecycle** — add a `paused` serving-state to `job_postings` (backward-compatible migration + rollback note; version any event payload change), plus `POST /payer/job-postings/:id/pause` and `/resume` (session-authed, ownership-scoped, lifecycle-guarded). Closes G4. **Owner: Divyanshu (+ database-architect for migration).**
3. **[P0] Posting applicant-quota route + counter** — `POST /payer/job-postings/:id/quota` backed by a real counter / pricing-engine integration; add quota to the posting projection. Closes G5/G10. **Owner: Divyanshu.**
4. **[P1] Wire `PATCH /payer/me`** — backend is LIVE; only frontend wiring needed (see §4). No backend work beyond confirming `.strict()` rejects email/role/status. Closes G9.
5. **[P1] Credit-ledger read** — `GET /payer/credits/ledger` (payer-scoped, PII-free top-ups + spends) so history is authoritative, not client-synthesized. Closes G8.
6. **[P1] Masked-resume — no backend work** — `POST /payer/resume-disclosures` already LIVE; this is wiring only (G6).
7. **[P2 / Phase-2] Org-member / Team-RBAC API** — `POST/GET/DELETE /payer/org/members` (session-scoped tenancy, owner vs recruiter roles). Deferred per CLAUDE.md §8. Closes G7.
8. **[P2 / Phase-2] Posting demand-parity DTO expansion** — grow `PayerCreateJobPostingSchema` to accept trade/pay/exp and store on the jobs table. Closes G11.
9. **[P2] Mobile-auth contract note** — document Bearer-from-body for Rishi (Flutter); optionally support an `x-session-token` request header. Addresses G13.
10. **[P3] Pagination** on list endpoints (offset/cursor + totalCount). Addresses G15.

**Stay OFF for staging (no work):** real payments (`PAYMENTS_ENABLE_REAL=false`), real WhatsApp send, capacity enforcement (`CAPACITY_ENFORCEMENT_ENABLED=false`). `is_new_payer` (G12) is a cosmetic cleanup, not gating.

---

## 4. Frontend Wiring Work Needed (ordered)

Switch each payer-web seam function from mock → live **once the matching endpoint exists**:

1. **`revealMaskedResume()` (payer-api.ts:704-718)** → call live `POST /payer/resume-disclosures` (`{ worker_id, job_posting_id }` → `{ ok, disclosure_id, status, resume_url, expires_at }` | `{ status:'unavailable' }`). **No backend dependency — do first.** (G6)
2. **Account edit** → wire account page/actions to `PATCH /payer/me` (`{ orgName?, phone? }`), re-read `GET /payer/me` after. **No backend dependency.** (G9)
3. **`pausePosting()` / `resumePosting()` (payer-api.ts:729,742)** → call `POST /payer/job-postings/:id/pause` and `/resume` after backend item §3.2 lands; drop mock-store calls. (G4)
4. **`topUpPostingQuota()` (payer-api.ts:757)** → call `POST /payer/job-postings/:id/quota`; map real `applicantQuota` into the posting/capacity projection (remove the `applicantQuota := 0` placeholder). (G5/G10)
5. **`getCreditTopUps()` (payer-api.ts:273)** → call `GET /payer/credits/ledger`; remove the client-side `buildTransactionHistory` mock-store merge once the ledger is authoritative. (G8)
6. **Buy-plan / buy-boost (Employer)** → add new seam fns calling `POST /payer/job-postings/:id/plan|boost` (tier/coupon only) after backend item §3.1. Today these are clearly-seamed WAITING shims with no live caller. (G1/G2)
7. **Org-members (`org-members.ts`)** → wire `listOrgMembers/inviteOrgMember/removeOrgMember` to `/payer/org/members` once backend §3.7 lands (Phase-2). (G7)
8. **Posting demand-parity fields** → stop withholding tradeKey/payMin/payMax/exp in `toPayerJobPostingBody` once `PayerCreateJobPostingSchema` accepts them (Phase-2). (G11)

---

## 5. Final-Task Checklist per Flow

Owners: **Prakash** (TL/coordination, ADR/escalation), **Divyanshu** (backend/AI), **Rishi** (Android/Flutter — mobile-auth only), **QA**.

| Flow | Current % | What's left | Owner | Acceptance criteria | Test gate |
|---|---|---|---|---|---|
| **Login** (signup/request/verify/refresh/logout) | 100% | None (LIVE, no-enum, real OTP) | Divyanshu (verify) / QA | Signup→email code→verify mints session; identical response for unknown email; logout revokes; refresh past half-life works | e2e auth happy-path + no-enumeration assertion; rate-limit 429 test |
| **Dashboard** (`/payer/me`, credits, capacity reads) | 100% | None | QA | After login, `/payer/me` returns masked phone (last4), `GET /payer/credits` balance, `GET /payer/capacity` real `active_plan_count` | contract test on wire schemas; no-store header check |
| **Post Job** (employer create/publish) | 95% | Optional demand-parity fields deferred (G11) | Divyanshu | Create draft → publish (draft→open); org_label session-derived; vacancies→band server-side; emits `job_posting.created/.published` | e2e create+publish; event-emission assertion; PII screen on description |
| **Manage Postings** (list/get/edit/close) | 80% | Pause/Resume (G4) + quota top-up (G5) live wiring | Divyanshu + FE | Pause sets serving-state and stops reach serving; resume restores; quota top-up increments real counter; neutral 404 on foreign id | e2e lifecycle (draft→open→pause→resume→close); IDOR 404 test; event-versioning check |
| **Applicant Feed** (faceless reach) | 100% | None | QA | Owned-job applicants returned faceless (opaque id + bands); foreign/unknown → identical 404; 429 on cap; `feed.shown` PII-free | contract test on `ApplicantRowDto`; no-PII payload assertion; rate-limit test |
| **Unlock / Reveal** (contact) | 100% | None | QA | Unlock spends 1 credit; neutral `unavailable` on all denials; reveal returns opaque `relay_handle` (never phone); per-worker caps hold | e2e unlock→reveal; no-oracle byte-identical body test; per-worker cap test |
| **Masked Resume** (after unlock) | 60% | Swap mock shim → live `POST /payer/resume-disclosures` (G6) | Divyanshu (FE wiring) | Reveal returns signed `resume_url`, masked initials only, free (no credit debit); `unavailable` on deny | e2e disclosure; no-PII (no name/phone in body) assertion; signed-URL TTL check |
| **Wallet / Credits** (balance/top-up/history) | 75% | Credit-ledger read (G8); top-up is mock money (intended OFF) | Divyanshu | Live balance accurate; mock top-up increments; history reads authoritative ledger (not client-synthesized) | contract test on ledger; balance-after-spend reconciliation test |
| **Capacity** | 100% (shadow) | Confirm enforcement stays INERT on staging | Divyanshu / QA | `GET /payer/capacity` real count; buy upgrades allowance + auto-resumes plans; `CAPACITY_ENFORCEMENT_ENABLED=false` | e2e buy-capacity; `resumed_plan_ids` assertion; shadow-mode (no pause) test |
| **Agency Jobs** (create/list/get/edit/close/pause) | 100% | None (role-guarded LIVE) | QA | agent-role required (403/404 if not agent); pause==close Phase-1; faceless projection; events emit | e2e agent CRUD; role-guard negative test; no-PII projection assertion |
| **Agency Invites** (mint) | 100% | Real WhatsApp send stays OFF (G14) | QA | Mint returns opaque code+link; faceless (no phone/name); per-payer mint cap → 429 fail-closed | e2e mint; 429 cap/Redis-down fail-closed test; faceless-body assertion |
| **Agency Referrals** (summary) | 100% | Worker attribution wiring is inert (Phase-2 fast-follow) | Divyanshu (note) | Aggregate counts only; counts < minBucket suppressed to 0; no per-invitee rows | k-anon floor test; aggregate-only assertion |
| **Team RBAC** (org members) | 10% (stub) | Full backend API + FE wiring (G7) — **Phase-2** | Divyanshu + FE | Owner can list/invite/remove members session-scoped; recruiter role gated | Deferred; ship "coming soon" + unit test on stub neutrality |
| **Account** (`PATCH /payer/me`) | 70% | Wire account edit (G9) | Divyanshu (FE wiring) | Edit orgName/phone; email/role/status immutable (rejected); emits `payer.account_updated` (keys only); empty patch → 400 | e2e edit; immutability/`.strict()` test; PII-free event (keys-only) assertion |

---

## 6. Ordered Sequencing — what unblocks what

**Wave 0 — zero-backend wiring (start immediately, parallel):**
- Wire `revealMaskedResume` → live `POST /payer/resume-disclosures` (G6) → unblocks **Masked Resume** flow to 100%.
- Wire account edit → `PATCH /payer/me` (G9) → unblocks **Account** to 100%.
- QA: lock e2e + no-PII + no-oracle regression suites on all already-LIVE flows (Login, Dashboard, Post Job create/publish, Applicant Feed, Unlock/Reveal, Capacity, Agency Jobs/Invites/Referrals).

**Wave 1 — P0 backend (Divyanshu, gated by migrations):**
- 1a. Posting `paused` lifecycle migration (backward-compat) → `pause`/`resume` routes (G4).
- 1b. Posting quota route + counter + projection field (G5/G10).
- 1c. Payer-authed `plan` + `boost` routes (G1/G2, LC-1) → guard/deprecate unguarded ops routes.
- Each followed by its payer-web seam swap (Wave 1 FE).

**Wave 2 — P1 backend + wiring:**
- Credit-ledger read `GET /payer/credits/ledger` (G8) → swap `getCreditTopUps`, drop client-side merge.

**Wave 3 — Phase-2 (post-staging, deferred):**
- Org-member / Team-RBAC API + wiring (G7).
- Posting demand-parity DTO expansion (G11).
- Mobile-auth Bearer-from-body doc/contract for Rishi (G13).
- Pagination (G15); `is_new_payer` cleanup (G12).

**Dependency chain:**
`Wave 0 (no deps)` → `Manage Postings to 100% requires Wave 1a+1b` → `Employer plan/boost purchase requires Wave 1c` → `Wallet history authoritative requires Wave 2` → **payer-web fully live on staging** once Waves 0–2 land, real money/WhatsApp/enforcement remain OFF, and QA's e2e + no-PII + no-oracle + IDOR suites are green. (Waves 3 are Phase-2 and ship as honest "coming soon"/deferred states without blocking staging go-live.)

**Definition of "fully live on staging":** all flows in §5 at 100% except Team RBAC (deferred, "coming soon"), Wallet top-up using mock money (intended), and agency real-WhatsApp send OFF (intended) — with every important action emitting a validated PII-free event and no raw PII in any response, log, or event.

---
_Generated 2026-06-29 from a verified API-surface extraction. Pair with [../api/payer-agency-api-reference.md](../api/payer-agency-api-reference.md). Re-verify after each wave lands._
