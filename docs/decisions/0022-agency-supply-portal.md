# ADR-0022: Agency Supply Portal — additive demand slice on the payer account (Phase-0 design)

- **Status:** **ACCEPTED (2026-06-22, human sign-off).** Phase-1 build authorized for the BUILD-NOW demand slice only, with the Appendix-C security conditions pinned-with-tests. The PARKED / LEGAL_MONEY_GATE / DEAD modules remain out of scope behind their named gates. This ADR draws the contract for an **Agency Supply Portal** that an agency (`payers.role = 'agent'`) uses, and classifies its candidate modules into BUILD-NOW (additive demand slice) / PARKED / LEGAL_MONEY_GATE / DEAD.
- **Date:** 2026-06-22
- **Phase:** Phase-2 fast-follow (web-app lock confirmed: demand loop = alpha, agency supply dashboard = fast-follow). **NOT a §2 invariant relaxation** — additive only, behind the same gates as ADR-0010/0019/0020.
- **Author:** system-architect (architecture + contract). Security-engineer MANDATORY before any build (this rides the external untrusted payer boundary ADR-0019 opened). Product-manager owns the parked attribution/payout params. Human/legal owns KYC + real money.
- **Builds on / reconciles (verified against the repo, 2026-06-22):**
  - **ADR-0019** (`docs/decisions/0019-self-serve-payer-portal.md`) — the `payers` account (`role 'employer'|'agent'`), `PayerAuthGuard`, the `assertPayerOwns`/`readOwnedById` tenant chokepoint (`apps/api/src/payers/payer-scope.ts`), and the R22 payer-self faceless read pattern (`apps/api/src/payer-portal/payer-reach.controller.ts`, `payer-unlocks.controller.ts`). **This is the account we REUSE — no new auth, no new principal.**
  - **ADR-0010** (`docs/decisions/0010-contact-unlock-and-reveal.md`) — the ₹40 routed-disclosure spine + `employer_sharing` consent + faceless rails. **The ONLY path to a worker identity stays this masked/consented/capped chokepoint, untouched.**
  - **ADR-0020** (`docs/decisions/0020-whatsapp-invite-funnel-and-reengagement.md`) — the MOCK invite funnel (`MESSAGING_ENABLE_REAL=false`) + `whatsapp_messaging` consent + the PII-free `invite.*`/`messaging.*` events.
  - **ADR-0012/0013** — the existing posting machinery (`apps/api/src/job-postings/*`, `apps/api/src/posting-plans/*`) the demand slice reuses.
  - **phase-2-agency-referral-payouts.md** — the PARKED locks: attribution/payouts/KYC are capture-only, nothing built; `90d / 25% / ₹500` are UNRATIFIED proposals; KYC = financial PII behind legal/DPDP; un-defer triggers 1–4.
  - **CLAUDE.md** §2 invariants #1 (event-first), #2 (no raw PII outside `workers`), #4 (LLMs never rank/decide), #6 (consent gate), #8 (additive/backcompat); §7 escalation; §8 deferred scope.
  - **packages/db/src/schema.ts** — `payers` (~L103, `role 'employer'|'agent'`), `invites` (~L1125, `inviter_worker_id` NOT NULL → worker→worker), `worker_consents` (~L127, append-only), `jobs` (~L662, opaque nullable `payer_id`, no FK), `job_postings` (~L545, opaque `created_by`, no `payer_id`).
  - **packages/event-schema/src/{registry,payloads}.ts** — the shipped `feed.shown` / `consent.accepted` / `unlock.*` / `payment.*` / `invite.*` / `job_posting.*` contracts. **Reused, never re-versioned.**

---

## Sign-off (2026-06-22)

Human sign-off obtained on the Phase-0 package. Decisions ratified:

1. **Plan APPROVED** — build the BUILD-NOW demand slice only (modules 5, 8, 9). PARKED (3), LEGAL_MONEY_GATE (1, 7), and DEAD (2, 4, 6) stay out of scope behind their named gates.
2. **Role model = "Agent-Only" (option (b) from Appendix C.2 #1).** A real role gate is added: `payers.role` is carried on the authenticated principal (role claim on the payer session / loaded from the `payers` row) and a `PayerRoleGuard`/`@PayerRoles('agent')` restricts the new agency routes — an `employer` token is **rejected** on agent-only routes (vertical authz), in addition to the existing `assertPayerOwns` tenant isolation (horizontal authz). Both are build-blocker tests.
3. **Security build-blockers ACCEPTED as pinned-with-tests** (Appendix C): consent-gated attribution write; aggregate-only / k-anonymous referrals summary (no per-invitee consent oracle); RLS/REVOKE-lock the new `invited_worker_id`; per-payer invite-mint cap; sibling `agency_invites` table (option i) as the default.

Mock + staging-only stays in force (`MESSAGING_ENABLE_REAL=false`, `PAYMENTS_ENABLE_REAL=false`). A `bb-security-review` PASS on the built surface remains the pre-merge gate. STOP + escalate before any KYC, attribution→payout, real comms/payments, matching/outcome, or agency handling of raw worker PII.

---

## Context

An agency (a labour supplier / staffing agent) is, per the master-context product lock, **a company** — it has the same demand-side needs as an employer (post roles, see who applied, pay to unlock contacts) **plus** a future supply-side referral/payout loop. ADR-0019 already shipped the `payers` account with `role 'employer'|'agent'`, `PayerAuthGuard`, the app-layer tenant chokepoint, and the R22 payer-self faceless reach view. The agency is therefore **not a new principal** — it is an existing `payers` row whose `role='agent'`.

The temptation with an "agency portal" is to bolt on the high-leverage supply features (bulk candidate upload, referral attribution, matching pipelines, placement tracking, commission payouts, KYC). **Every one of those either violates a §2 invariant, requires the deferred Reach Engine / a dead Employer entity, or is a real-money/legal escalation.** This ADR fixes the boundary BEFORE any code, exactly as ADR-0010/0019/0020 did: the agency gets the **same additive demand slice an employer gets**, faceless and event-first, and nothing else this phase.

The disciplines that govern every decision (restated): the agency **never** uploads or sees a worker's raw phone/name; the only path to a worker identity is the separate ₹40 unlock + `employer_sharing` consent chokepoint (ADR-0010); no processing of a worker before `consent.accepted` (invariant #6); `payer_id`/opaque ids only in events (invariant #2); additive-only (invariant #8); no LLM, no ranking on this path (invariants #3/#4).

---

## Module classification (authoritative)

| # | Module | Classification | Why |
|---|--------|---------------|-----|
| 5 | Agency dashboard — read-only faceless over OWN data | **BUILD_NOW** | mirrors `payer-reach.controller.ts`: `PayerAuthGuard` + session `payer_id` + `assertPayerOwns` + no-oracle 404 + per-payer cap; information-only, no rank/credit/payment; reuses `feed.shown` |
| 9 | Demand — job-posting CRUD (create/edit/pause/close) | **BUILD_NOW** | agency (`role='agent'`) drives existing posting machinery scoped by `PayerAuthGuard`+`assertPayerOwns`; additive, event-first, faceless, mock payments |
| 8 | Invites / comms hook (mock) | **BUILD_NOW** | ADR-0020 MOCK funnel (`MESSAGING_ENABLE_REAL=false`); additive, consent-gated. **Caveat:** `invites.inviter_worker_id` is NOT NULL (worker→worker) → an agency inviter needs an ADDITIVE entity, not a payload change |
| 3 | Supply / referral funnel + attribution | **PARKED** | capture-only with UNRATIFIED `90d/25%/₹500`; upstream signal for payouts; gated on TD34 + TD33 + product ratification |
| 1 | Agency KYC (bank/PAN/GST) | **LEGAL_MONEY_GATE** | new high-sensitivity financial PII; DPDP consent/purpose/retention + legal review prerequisites; CAPTURE-ONLY, nothing built |
| 7 | Payouts / commission ledger (money OUT) | **LEGAL_MONEY_GATE** | real money leaving the platform = §7 human gate; distinct from the credit ledger; presupposes real inbound payments (TD34) |
| 2 | Bulk worker/candidate upload (raw contacts) | **DEAD** | violates invariant #2 + ADR-0010 faceless rails; no gate ever revives bulk raw-phone ingest/export |
| 4 | Candidate matching / pipeline stages | **DEAD** | needs ranking (invariant #4) + an Employer pipeline; jobs are `open|closed` only; Reach Engine deferred (§8) |
| 6 | Hire / placement-outcome tracking | **DEAD** | no schema/event home (no interview/selected/hired states); hire/no-show on `dead-decisions.md`; needs Employer entity + Reach Engine |

---

## Decision

### (a) ACCOUNT REUSE — the agency is a `payers` row with `role='agent'`, nothing new

**No new auth, no new principal, no new guard, no new tenant chokepoint.** The agency portal reuses, verbatim:

- **`payers` account** (`packages/db/src/schema.ts` ~L103) — `role 'employer'|'agent'` already exists; an agency is `role='agent'`. B2B contact PII already lives here under ADR-0004 at-rest discipline (ADR-0019 B-R2), never in events. **No KYC/bank/PAN columns are added** — those are LEGAL_MONEY_GATE (§e).
- **`PayerAuthGuard`** + `@CurrentPayer()` (`apps/api/src/payers/payer-auth.guard.ts`) — the verified-session identity. `payer_id` is derived from the session, **never** from a route/body (XB-A), exactly as `PayerUnlocksController`/`PayerReachController` do.
- **`assertPayerOwns` / `readOwnedById` / `assertOwnedRows`** (`apps/api/src/payers/payer-scope.ts`) — the single app-layer tenant chokepoint; every agency data access passes the session `payer_id` through it. Horizontal-authz (agent A cannot touch agent B's rows) is the same build-blocker test ADR-0019 Decision C mandates.
- **Posting machinery** — `apps/api/src/job-postings/*` (`JobPostingsService.create/update/close`) and `apps/api/src/posting-plans/*` (`buyPlan/buyBoost`, mock payments behind `PAYMENTS_ENABLE_REAL=false`). The demand slice scopes these to the authenticated `role='agent'` payer.
- **R22 read pattern** — `apps/api/src/payer-portal/payer-reach.controller.ts`: `PayerAuthGuard` → per-payer hourly cap → `reach.applicantsForOwnedJob(jobId, payer.id, ctx)` → no-oracle identical 404 for unknown-or-not-owned → information-only `feed.shown` with the payer actor. The agency dashboard is this pattern, scoped to `role='agent'`.

**Surface:** the agency portal is served by `apps/payer-web` (the external app ADR-0019 Decision A authorized) — a role-aware view, **not** the internal `apps/web` ops console, and **not** a new app. One origin, one external auth domain, one principal class per route (worker / payer / ops never conflated).

### (b) CONSENT MODEL — invite-only; the worker self-onboards and consents BEFORE any processing

No processing of a non-consented worker is possible **by construction**, because the agency never holds a worker contact to process:

1. **The agency sends a MOCK invite** via the ADR-0020 funnel (`MESSAGING_ENABLE_REAL=false`, `MockWhatsAppProvider`). The agency shares only an opaque deep-link code (`/i/<code>`) — it never types or uploads a phone/name. The phone (if any) touches the provider only at send time, never the agency, never an event/log.
2. **The WORKER self-onboards** through the normal worker app: mock OTP → consent. A `worker_consents` row is written and **`consent.accepted` is emitted** (invariant #6 gate) **before** any profiling/AI processing. The agency plays no part in this and sees no PII from it.
3. **Attribution attaches ONLY AFTER `consent.accepted`** — a capture-only INTENT record (§d) keyed on the invite code links the agency's `payer_id` to the now-consented `invited_worker_id`. It is a faceless signal, not a processing trigger and not a payout (payouts are PARKED, §e). It cannot exist before consent because the worker id it references does not exist until the worker self-onboards and consents.
4. **`employer_sharing` is a separate, second consent** (ADR-0010) — the agency reaching a worker's actual contact still requires that distinct, fail-closed, revocable consent at the ₹40 unlock chokepoint. Onboarding/profiling consent does NOT authorize disclosure.

There is **no agency-side path that processes a worker the agency "uploaded"** — bulk upload is DEAD (§e). The only worker the agency can influence is one who self-onboarded and self-consented.

### (c) FACELESS BOUNDARY — the agency sees only PII-FREE progress of its OWN data

- The agency dashboard (module 5) renders **opaque ids + counts + enums only**: the agency's own `jobs`/`job_postings` (by status), per-job applicant counts (`jobs.applicants_received`, an integer rollup), the faceless ranked applicant list (worker opaque ids + the ADR-0011 faceless projection that powers `feed.shown`), and — for its referred workers — **counts by funnel stage** (`invited → joined(consented) → applied`) keyed on opaque `invited_worker_id`. **Never a phone, name, address, or employer name.**
- **Every event carries opaque agency/job/worker ids only.** Reused `feed.shown`, `job_posting.*`, `unlock.*`, `payment.*`, `invite.*` payloads are already PII-free (verified in `payloads.ts`); the agency view emits them with the payer actor exactly as R22 does. No raw phone, ever, in any payload or log.
- **The only path to a real identity is unchanged:** the separate ₹40 unlock + `employer_sharing` consent + caps + routed reveal chokepoint (ADR-0010), which the agency reaches through the **already-shipped** `PayerUnlocksController` (`/payer/unlocks*`). The agency portal adds **no new disclosure path** and touches none of the unlock/reveal code. Worker raw PII stays FORCE-RLS+REVOKE in `workers`.

### (d) The minimal ADDITIVE entity the build-now slice needs

An **`agency_invites` / attribution-INTENT record**, faceless, keyed by OPAQUE ids only:

- `id` (uuid PK) · `inviter_payer_id` (uuid, the agency `role='agent'` opaque ref — **no FK retrofit decision below**) · `code` (opaque deep-link token) · `invited_worker_id` (uuid, nullable, set only **after** the worker's `consent.accepted`) · `channel` (enum) · `status` (enum `created|clicked|accepted`) · `campaign?` (non-PII tag) · timestamps.
- **NO KYC, NO bank, NO PAN, NO GST, NO payout ledger, NO commission, NO money column.** It is an attribution INTENT signal only — the upstream record the PARKED payout model (§e) will one day consume, kept ids-only so it composes without a PII bridge (exactly the ADR-0020 Decision 3 design intent).
- **Why a NEW entity and not the existing `invites` table:** `invites.inviter_worker_id` is NOT NULL (worker→worker, `schema.ts` ~L1131) and the `invite.created`/`invite.accepted` payloads carry `inviter_worker_id` as a required uuid (`payloads.ts` ~L827/L841). An agency inviter is a **payer**, not a worker. Mutating that column or those payloads to admit a payer inviter would break invariant #8 (backward compatibility). So the agency inviter is **additive**, not a payload change.
- **BUILD-TIME DB DECISION (flag, do not pre-decide here):** either (i) a **sibling `agency_invites` table** (cleanest separation, no risk to the shipped worker→worker funnel), or (ii) a **new nullable `inviter_payer_id` column on `invites`** with a CHECK that exactly one of `inviter_worker_id` / `inviter_payer_id` is set. Recommendation leans (i) sibling table for clean separation and zero blast radius on the shipped funnel; the database-architect makes the final call via `safe-db-migration` at build time. **Either way it is additive** — no shipped column altered, no shipped payload mutated.
- New events, if needed, are **PII-free and additive** (see demandSliceDesign) — never a re-version of a shipped payload.

### (e) Explicit DEFERRALS with NAMED gates

- **Agency KYC (module 1) — LEGAL_MONEY_GATE.** New financial PII (bank/PAN/GST). **Gate:** legal/DPDP sign-off on agency KYC (financial PII: consent/purpose/retention) + un-defer trigger #3. Nothing built; no KYC column added by this ADR.
- **Supply/referral attribution → payout (modules 3 → 7) — PARKED → LEGAL_MONEY_GATE.** Attribution INTENT capture is the additive `agency_invites` record (§d), but the **payout model** is parked. **Gate:** product-ratify the attribution model (`90d / 25% / ₹500` — currently UNRATIFIED proposals) + **TD34** real inbound payments + **TD33** `PayerAuthGuard` real identity; payouts additionally need **§7 human authorization of real outbound money** + the same `PAYMENTS_ENABLE_REAL`-style discipline (un-defer triggers 1, 2, 4).
- **Matching / pipeline stages (module 4) — DEAD.** Needs ranking (invariant #4 forbids LLM ranking) and an Employer pipeline. Jobs are `open|closed` only. **Gate: none — the Reach Engine is deferred (§8) and the Employer entity is on `dead-decisions.md`.**
- **Hire / placement-outcome tracking (module 6) — DEAD.** No schema/event home (no interview/selected/hired states); hire/no-show signals are on `dead-decisions.md`. **Gate: none.**
- **Bulk raw-phone upload (module 2) — DEAD.** Violates invariant #2 + the ADR-0010 faceless rails. **Gate: none — no gate ever unlocks bulk raw-phone ingest or contact export.**

---

## EXPLICITLY OUT — hard boundary (do not drift)

- No bulk candidate/contact upload; no contact/list export; no enumeration (ADR-0010 anti-scrape spine + invariant #2).
- No ranking/matching/pipeline; no `@badabhai/reach-engine` decisioning on this path; no LLM anywhere (invariants #3/#4). The faceless applicant list reuses the existing deterministic ADR-0011 projection — information-only.
- No hire/interview/selected/no-show states; jobs stay `open|closed`.
- No KYC/bank/PAN/GST/payout/commission column or table; no real outbound money.
- No new principal/guard/auth; no conflation of agent/employer/ops/worker; one principal class per route.
- No mutation of a shipped payload or column (invariant #8). Additive only: `agency_invites` (or a nullable `inviter_payer_id` column — build-time choice), the agency-scoped read/CRUD routes on `apps/payer-web`, and at most ONE new PII-free event if genuinely required.
- No real WhatsApp send / no provider spend (`MESSAGING_ENABLE_REAL=false`); no real payments (`PAYMENTS_ENABLE_REAL=false`) — both stay mock until their human gates.

---

## Phased plan (each phase STOPS at its gate)

| Phase | Scope | Gate to ENTER |
|---|---|---|
| **0 — this ADR** | classification + demand-slice DESIGN. No code. | — (you are here; status Proposed) |
| **1 — demand slice (mock, staging-only)** | agency-scoped job CRUD (modules 9) + read-only faceless dashboard (5) + mock invite hook with the additive `agency_invites` INTENT record (8). All `role='agent'`-scoped via `PayerAuthGuard`+`assertPayerOwns`, no-oracle, per-payer cap, mock payments/messaging. | Human/RVM sign-off on this ADR + a `bb-security-review` PASS (external boundary, reuses ADR-0019 controls) |
| **2 — supply/attribution → payout** | the parked referral/payout model | TD34 + TD33 closed + product-ratified `90d/25%/₹500` + legal/DPDP on KYC + §7 human gate on real outbound money |

---

## Consequences

- **Positive:** the agency portal ships with **zero new trust boundary** beyond what ADR-0019 already opened and security-reviewed — same account, guard, tenant chokepoint, no-oracle, caps. Reusing `feed.shown`/`payment.*`/`unlock.*`/`invite.*` means no event-schema churn and no version strategy burden. The faceless boundary and consent gate hold by construction, not by discipline. Fully reversible: drop `agency_invites` and the agency-scoped routes; the shipped worker→worker funnel and payer surfaces are untouched.
- **Negative / risk:** the `invites` worker→worker shape forces an additive entity rather than reuse — a small duplication, accepted to preserve invariant #8. The parked attribution params (`90d/25%/₹500`) being unratified means the `agency_invites` INTENT record is captured before its consuming model is finalized; mitigated by keeping it ids-only and payout-free so the later model consumes it without a migration.
- **Rollback story:** Phase-1 is additive-only (one new table or one nullable column + new routes on `apps/payer-web` + at most one new PII-free event). Rollback = drop the new table/column child-first and remove the routes; already-emitted PII-free events persist independently in the `events` spine; no Phase-1 worker data is touched.

---

## Related
- ADR-0019 (`docs/decisions/0019-self-serve-payer-portal.md`) — `payers role='agent'`, `PayerAuthGuard`, `assertPayerOwns`, R22 reach pattern (the account REUSED)
- ADR-0010 (`docs/decisions/0010-contact-unlock-and-reveal.md`) — ₹40 unlock + `employer_sharing` consent + faceless rails (the ONLY identity path)
- ADR-0020 (`docs/decisions/0020-whatsapp-invite-funnel-and-reengagement.md`) — the MOCK invite funnel + PII-free attribution
- ADR-0012/0013 — `apps/api/src/job-postings/*`, `apps/api/src/posting-plans/*` (the posting machinery reused)
- `docs/sprint-plans/phase-2-agency-referral-payouts.md` — the PARKED supply/payout/KYC locks + un-defer triggers
- `packages/db/src/schema.ts` (`payers` ~L103, `invites` ~L1125, `jobs` ~L662, `worker_consents` ~L127); `packages/event-schema/src/{registry,payloads}.ts`
- CLAUDE.md §2 invariants 1, 2, 4, 6, 8; §7 escalation; §8 deferred scope

---

## Appendix A — BUILD-NOW demand slice (design only, awaiting sign-off)

BUILD-NOW DEMAND SLICE — DESIGN ONLY (mirrors R22 payer-reach; nothing built this phase). All routes on apps/payer-web, scoped to the authenticated payers.role='agent'; one principal per route; PayerAuthGuard + assertPayerOwns + no-oracle + per-payer cap throughout.

== ENTITIES ==
REUSED (no change):
- payers (role='agent') — the agency account (schema.ts ~L103). PayerAuthGuard derives payer_id from the session.
- jobs (jobs.payer_id, opaque nullable, no FK, ~L662) — the agency's OWNED demand objects; applicants_received is the PII-free rollup; pay/exp/neededBy bands feed the existing reach projection.
- job_postings (~L545) + posting_plans (mock payments, PAYMENTS_ENABLE_REAL=false) — the existing CRUD + paid-plan machinery.
- worker_consents (~L127) + consent.accepted — the worker self-onboard gate (agency never participates).
NEW (additive, faceless, ids-only — the ONLY new entity):
- agency_invites (attribution-INTENT): id PK · inviter_payer_id (opaque agency ref, no FK) · code (opaque token) · invited_worker_id (nullable, set ONLY after consent.accepted) · channel enum · status enum(created|clicked|accepted) · campaign? · timestamps. NO KYC/bank/PAN/GST/payout/commission/money column. BUILD-TIME DB DECISION: sibling table (recommended) vs nullable inviter_payer_id column on invites with a one-of CHECK — flag for database-architect; either way additive (invites.inviter_worker_id is NOT NULL worker→worker, so reuse is impossible without breaking invariant #8).

== APIs (all @UseGuards(PayerAuthGuard), @CurrentPayer() payer, role='agent'; payer_id NEVER from route/body — XB-A) ==
Demand CRUD (module 9) — wraps existing services, scoped + assertPayerOwns:
- POST   /payer/jobs                  create an owned job (sets jobs.payer_id = payer.id). 201.
- PATCH  /payer/jobs/:jobId           edit/publish; readOwnedById then JobPostingsService.update. no-oracle 404 if unknown-or-not-owned.
- POST   /payer/jobs/:jobId/pause     pause (if lifecycle supports; else map to status within open|closed). no-oracle.
- POST   /payer/jobs/:jobId/close     close (→ closed, terminal). no-oracle. 200.
- POST   /payer/jobs/:jobId/plan      buy a posting plan (mock payment). reuses PostingPlansService.buyPlan. assertPayerOwns first.
- POST   /payer/jobs/:jobId/boost     buy a boost (mock). reuses buyBoost. assertPayerOwns first.
Read-only faceless dashboard (module 5) — mirrors PayerReachController exactly:
- GET    /payer/jobs                  list OWN jobs (assertOwnedRows; PII-free projection: ids/status/counts/bands).
- GET    /payer/jobs/:jobId           one OWN job; readOwnedById → neutral 404 if unknown-or-not-owned (no-oracle).
- GET    /payer/reach/jobs/:jobId/applicants  REUSE the shipped route/pattern: rateLimit.assertWithinHourlyCap(payer.id, PAYER_REACH_MAX_PER_HOUR) → reach.applicantsForOwnedJob(jobId, payer.id, ctx). Information-only — NO rank/credit/payment.
- GET    /payer/referrals/summary     OWN agency_invites funnel counts by stage (invited/joined/applied), opaque ids only.
Mock invite hook (module 8):
- POST   /payer/invites               agency mints an OWN referral code → writes agency_invites(inviter_payer_id=payer.id, status=created). Shares only the opaque code; NO phone/name input. (Optional mock send rides ADR-0020 MockWhatsAppProvider, MESSAGING_ENABLE_REAL=false, whatsapp_messaging consent fail-closed.)
- POST   /payer/invites/:code/click   public attribution (PII-free; neutral on unknown).
Unlock/disclosure: NO new route — the agency reaches a worker identity ONLY via the already-shipped /payer/unlocks* (ADR-0010 chokepoint, ₹40 + employer_sharing + caps). This slice adds no disclosure path.

== EVENTS (REUSE shipped, PII-free, NEVER re-version) ==
- Demand CRUD: job_posting.created / job_posting.updated / job_posting.closed / job_posting.purchased / job_posting.boosted (all shipped, ids/enums/bands only).
- Dashboard read: feed.shown (shipped FeedShownPayload: worker_id/job_id/rank/score/hot — PII-free) with the payer actor, exactly as R22 emits it. Information-only.
- Worker onboard: consent.accepted (shipped) — emitted by the worker flow, the §6 gate; agency does not emit it.
- Unlock (separate chokepoint): unlock.* / payment.* (shipped) — only via /payer/unlocks*.
NEW PII-FREE events — add ONLY if genuinely required (additive, v1, ids/enums only; authored via event-schema-change):
- agency_invite.created  { agency_invite_id, inviter_payer_id, channel, campaign? }
- agency_invite.accepted { agency_invite_id, inviter_payer_id, invited_worker_id }  ← emitted ONLY after the worker's consent.accepted; the capture-only attribution INTENT.
These are NEEDED rather than reusing invite.*/invite.accepted because those payloads carry inviter_worker_id as a REQUIRED uuid (payloads.ts ~L827/L841) — a payer inviter cannot ride them without mutating a shipped payload (invariant #8). NO phone/name/body in either — opaque ids + enums only.

== PERMISSIONS ==
- Principal: payers.role='agent', via PayerAuthGuard (session-derived payer_id; never route/body — XB-A). Distinct from employer-payer, ops (InternalServiceGuard), worker (WorkerAuthGuard); one principal per route.
- Tenant isolation: every read/write passes session payer_id through assertPayerOwns / readOwnedById / assertOwnedRows (payer-scope.ts). Horizontal-authz test (agent A cannot touch agent B) is a build-blocker (ADR-0019 Decision C).
- No-oracle: unknown-vs-not-owned return the IDENTICAL neutral 404 (mirrors PayerReachController + reach.applicantsForOwnedJob).
- Scrape bound: per-payer hourly cap on the reach read (PAYER_REACH_MAX_PER_HOUR), reused from PayerDisclosureRateLimit; the per-worker disclosure cap (payer-count-independent) still backstops any unlock.
- payer↔worker PII isolation: agency never reads workers; identity only via the ADR-0010 masked/consented/capped chokepoint.

== DASHBOARD (apps/payer-web, role-aware agency view; PII-FREE only) ==
- My Jobs: own jobs by status (open|closed), applicants_received counts, plan/boost state — ids/enums/counts only.
- Job detail → Applicants: the faceless ranked list (reach.applicantsForOwnedJob) — opaque worker ids + the existing ADR-0011 faceless projection; information-only, with an "Unlock contact" action that routes to the SEPARATE shipped /payer/unlocks* chokepoint (₹40 + employer_sharing + caps).
- Referrals: own agency_invites funnel — counts by stage (invited→joined(consented)→applied), opaque invited_worker_id only. NO payout/commission UI (PARKED).
- Top-up/credits: reuse the shipped mock credit surface (/payer/credits) for unlock spend; mock only.
NOT on the dashboard: any phone/name/address; any bulk export; any matching/pipeline/hire-stage UI; any KYC/bank/payout UI (DEAD or LEGAL_MONEY_GATE).

---

## Appendix B — Deferrals with named gates

KYC (module 1) — LEGAL_MONEY_GATE. New financial PII (bank/PAN/GST). GATE: legal/DPDP sign-off on agency KYC (consent/purpose/retention for financial PII) + un-defer trigger #3. No KYC column added by this ADR. Same at-rest discipline as workers (ADR-0004) IF/when built.

ATTRIBUTION (module 3) — PARKED. The additive agency_invites INTENT record is captured (ids-only, payout-free) but the attribution MODEL is parked. GATE: product-ratify the model (90d window / 25% share / ₹500 — all currently UNRATIFIED proposals in phase-2-agency-referral-payouts.md) + TD33 (PayerAuthGuard real identity, paying down) for attribution authz + TD34 (real inbound payments) since conversion attaches to a real unlock. Un-defer triggers 1–2.

PAYOUTS / commission ledger (module 7) — LEGAL_MONEY_GATE. Real money OUT, distinct from the credit ledger (which is credits IN). GATE: TD34 real outbound payments + PAYMENTS_ENABLE_REAL-style discipline + §7 human authorization of real money movement + product-ratified ₹500 payout terms (floor vs cap vs flat still open) + KYC gate cleared (no payout to an un-KYC'd agency). Un-defer triggers 1, 2, 4. Nothing built.

MATCHING / pipeline stages (module 4) — DEAD. Needs ranking (invariant #4 forbids LLM rank/decide) + an Employer pipeline. Jobs are open|closed only (job-postings.dto.ts). GATE: NONE — the Reach Engine is deferred (§8) and the Employer entity is on dead-decisions.md. Not revived by any gate in this ADR.

OUTCOME / hire-placement tracking (module 6) — DEAD. No schema or event home (no interview/selected/hired states); hire/no-show signals on dead-decisions.md; would require an Employer entity + Reach Engine. GATE: NONE.

(Reference DEAD: bulk raw-phone upload (module 2) — violates invariant #2 + ADR-0010 faceless rails. GATE: NONE — no gate ever unlocks bulk raw-phone ingest or contact/list export.)

REAL COMMS / REAL PAYMENTS on the build-now slice itself stay MOCK: MESSAGING_ENABLE_REAL=false (ADR-0020) and PAYMENTS_ENABLE_REAL=false (ADR-0010/0013) — flipping either is a separate §7 human gate (real provider keys/spend, staging-first), NOT cleared by this ADR.

---

## Appendix C — Pre-build SECURITY CONDITIONS (Phase-0 gate output — both reviewers: PASS_WITH_CONDITIONS)

These are build-blockers to PIN before any Phase-1 code. No FAIL was raised; the conditions below MUST be satisfied (and tested) when the demand slice is built.

### C.1 Privacy / PII lead (security-engineer) — verdict: PASS_WITH_CONDITIONS
1. [HIGH — build-blocker, not yet a defect] Attribution-after-consent is an UNENFORCED ORDERING in the design. The ADR asserts `agency_invite.accepted` / setting `invited_worker_id` happens 'ONLY AFTER consent.accepted', but the existing analogue (apps/api/src/messaging/invite.service.ts `recordAccept(code, invitedWorkerId)`) sets `invitedWorkerId` and emits `invite.accepted` WITHOUT ANY consent-row check — it trusts the caller to pass a consented worker id. If the agency funnel copies that shape, an attribution write (processing of a worker record on the agency's behalf) could attach before/independent of `consent.accepted`. REQUIRED before build: the agency-attribution write MUST be gated on `findLatestByWorker(workerId)` existing + `revokedAt IS NULL` at the chokepoint, with a build-blocker test asserting attribution is rejected/no-op when the invited worker has no active consent row. Do not rely on call-ordering discipline. **(SATISFIED 2026-06-23 — pinned-with-tests:** `AgencyService.attributeWorkerToInvite` gates on the active-consent check fail-closed, and the `agency.service.test.ts` `attributeWorkerToInvite` suite test-locks this by construction — no-consent/revoked no-op + no event, ids-only PII-free `agency_invite.accepted` payload, `system/null` actor + dedupe key, and the race-loss no-op. The seam remains INERT/unwired pending the worker-facing leg — see [TD48](../registers/tech-debt-register.md).)**

2. [HIGH — build-blocker] `GET /payer/referrals/summary` funnel counts are a potential consent/onboarding ORACLE. Counts by stage (invited -> joined(consented) -> applied) keyed on opaque `invited_worker_id` let an agency observe that a SPECIFIC invited individual consented/joined — i.e. it leaks a worker's onboarding+consent decision back to the inviter, even faceless. The no-oracle rule (ADR-0010 §D4 / F-3, the payer-reach addendum) must extend here: REQUIRED that referral stage data is exposed only as AGGREGATE counts with a minimum-bucket floor (k-anonymity), never per-invite-resolvable to a single person, and that an unknown/never-consented code returns a neutral indistinguishable result. Pin a test that one agency cannot determine whether one named invitee consented.

3. [MEDIUM] `agency_invites.invited_worker_id` is a NEW join from a payer-owned, agency-readable row to `workers.id`. Even though it is an opaque UUID, it creates a payer-side handle onto a worker identity that did NOT exist before. REQUIRED: this column must be REVOKE/RLS-locked exactly like `unlocks.worker_id`, must NEVER be returned raw in any agency-facing payload (only ever via the aggregate funnel of the prior finding), and must NOT become an alternate enumeration path into the unlock chokepoint. Database-architect to add it to the rls-plan (TD20) at build; the no-FK-vs-FK choice does not change this obligation.

4. [MEDIUM] Account-farming inherits from ADR-0019 but is RE-OPENED by free invite minting. `POST /payer/invites` lets an `agent` mint unlimited opaque codes; combined with multiple agent accounts this multiplies both per-payer reach caps AND attribution surface. REQUIRED: a per-payer invite-mint cap (the ADR-0020 'per-inviter invite caps' analogue) and confirmation that the per-WORKER disclosure cap (payer-count-independent, ADR-0019 Decision E backstop) still bounds any downstream unlock regardless of how many agent accounts/codes exist.

5. [LOW] The build-time DB choice (sibling `agency_invites` table vs nullable `inviter_payer_id` on `invites` + one-of CHECK) is correctly flagged, but option (ii) carries a real risk: adding a payer-referencing column to the shipped worker->worker `invites` table puts a payer handle on a row whose `invite.*` payloads are worker-shaped. Recommend the sibling table (option i) be made the DEFAULT, not merely 'recommended', to keep zero blast radius on the shipped funnel and avoid any temptation to widen the shipped `invite.*` payloads (invariant #8).

**Consent model:** Consent-before-processing is SOUND BY DESIGN but NOT YET AIRTIGHT BY CONSTRUCTION — it depends on a build-time ordering that the existing code analogue does not enforce. Strengths (verified): (1) the agency holds NO worker contact to process — it shares only an opaque `/i/<code>`; bulk upload is DEAD (§e); so there is no 'agency-uploaded worker' to process. (2) The worker self-onboards through the normal worker app: mock OTP -> consent -> `worker_consents` row + `consent.accepted` emitted; ConsentGuard (apps/api/src/auth/consent.guard.ts) gates all worker processing on the latest unrevoked consent row, fail-closed, and reads `req.worker` (never a client/agency-supplied id). The agency cannot emit `consent.accepted` (actor is `worker`, the worker's own session). (3) `employer_sharing` is correctly a SEPARATE second consent for any identity disclosure — onboarding consent does not authorize reach. GAP (the one real adversarial hole): the ADR claims attribution attaches 'ONLY AFTER consent.accepted' and argues it 'cannot exist before consent because the worker id does not exist until the worker self-onboards.' That argument holds for `invited_worker_id` being NON-NULL, but the EMISSION/WRITE of attribution is not itself consent-checked in the existing `recordAccept` pattern — it trusts the caller. So 'after the worker id exists' is not the same as 'after consent.accepted is durably recorded'. Can the agency CAUSE processing of a non-consented worker? Not directly (no upload, no agency-side worker session), but the attribution write is the one place where the design must PROVE ordering. REQUIRED CONDITION: gate the agency-attribution write on an active consent row + a build-blocker test. With that pinned, the model is airtight; without it, it is discipline, not construction.

**Faceless boundary:** FACELESS BOUNDARY HOLDS BY CONSTRUCTION for the BUILD-NOW slice, with one tightening required. Verified against the repo: (1) the reused dashboard projection `applicantsForOwnedJob` (apps/api/src/reach/reach.service.ts) returns ApplicantRowDto = { workerId(opaque UUID), rank, score, hot, pushEligible, components } — NO phone/name/address/employer name. (2) All reused payloads are PII-free in payloads.ts: FeedShownPayload (worker_id/job_id/rank/score/hot), invite.* (opaque ids + channel + optional non-PII campaign), unlock.*/payment.* (ids/enums/credits only). (3) Payer B2B PII lives only in `payers` under ADR-0004 at-rest discipline (emailEnc/emailHash/phoneEnc/orgNameEnc), never in events — `payer_id` is the only token, confirmed. (4) The proposed `agency_invites` is ids-only with NO phone/name/KYC/money column; new events `agency_invite.created/accepted` are specified ids/enums-only. (5) The only path to a real worker identity stays the separate ADR-0010 ₹40 + `employer_sharing` + caps + routed-reveal chokepoint via the already-shipped `/payer/unlocks*`; the slice adds NO new disclosure route, and raw phone is read from `workers` only at routed-reveal, never persisted/evented/logged. CONCLUSION: no raw worker PII (phone/name/address) can reach the agency UI, an event, ai_jobs, audit_logs, or a log under this design. THE ONE TIGHTENING (see Critical/High #2/#3): the NEW agency-readable `invited_worker_id` handle + the per-stage referral funnel must be aggregate-only / k-anonymous and RLS-locked, else the boundary stays faceless for PII but leaks a worker's consent/onboarding DECISION to the inviter — a behavioural-privacy leak even without raw PII. Faceless on PII: yes. Faceless on behaviour: only after the funnel is made aggregate.

**KYC escalation:** STOP -> LEGAL/HUMAN. Agency KYC (bank / PAN / GST) is correctly classified LEGAL_MONEY_GATE and is correctly NOT in the build-now slice — CONFIRMED: the ADR adds NO KYC/bank/PAN/GST column or table, and the proposed `agency_invites` entity explicitly carries none. This is new high-sensitivity FINANCIAL PII, a distinct class from both worker PII (invariant #2) and the already-escalated payer B2B contact PII (ADR-0019 B-R2). It must NOT be captured until: (a) legal/DPDP sign-off on lawful basis, purpose limitation, consent/notice copy, retention window, and erasure story; (b) the same ADR-0004 at-rest discipline (encryption + keyed-hash lookup + FORCE-RLS + REVOKE) as `workers`/`payers`; and (c) a hard rule that KYC fields NEVER touch events / ai_jobs / audit_logs / logs / LLM input. Payouts (module 7, real outbound money) are an additional §7 human gate and presuppose KYC cleared (no payout to an un-KYC'd agency) + real inbound payments (TD34). The financial-PII KYC question stays PARKED behind legal; nothing is captured this phase. This escalation is logged for the human/legal track and must be re-reviewed by security-engineer if/when un-parked.

### C.2 Independent authz/IDOR (security-reviewer) — verdict: PASS_WITH_CONDITIONS
1. [HIGH — design/build gap, must pin before build] Role is ASSERTED but NOT ENFORCEABLE today. The ADR + demandSliceDesign repeatedly describe routes as 'scoped to the authenticated payers.role=\'agent\'' and 'one principal per route, never conflated'. I verified the reused auth stack and there is NO role gate anywhere: PayerAuthGuard (apps/api/src/payers/payer-auth.guard.ts:60) attaches only {id, sid}; the JWT carries only {sub, sid, typ:'payer'} (apps/api/src/payers/payer-session.service.ts:82) with NO role claim; the session Redis blob stores only {payer_id} (payer-session.service.ts:77); assertPayerOwns (apps/api/src/payers/payer-scope.ts:18) checks id ONLY. A grep for any RoleGuard/@Roles/payer.role/validated.role across apps/api/src returns nothing. CONSEQUENCE: an authenticated role='employer' payer can call the new /payer/jobs, /payer/referrals/summary, /payer/invites routes; the engineer cannot 'scope to role=agent' with any existing primitive. This is NOT a cross-tenant breach (id-based assertPayerOwns still isolates each payer to its OWN rows), but the design's stated principal-separation guarantee for agent-vs-employer is currently fictional. REQUIRED FIX before build: either (a) explicitly accept that the demand slice is the SAME for employer and agent and DELETE all 'role=agent-scoped' / 'distinct from employer-payer' language (the honest position, since the slice is literally 'the same demand slice an employer gets'), OR (b) add an explicit role gate — add role to the AuthenticatedPayer (load from payers row or add a role JWT claim) and a RoleGuard, with a horizontal+vertical authz test that an employer token is rejected on agent-only routes. Do not let 'role=agent' enforcement be assumed.

2. [HIGH — must be a build-blocking test, not prose] The whole isolation story rests on assertPayerOwns/readOwnedById/assertOwnedRows being applied to EVERY new agency read AND write, including the NEW agency_invites entity and the new /payer/referrals/summary + /payer/invites/:code routes. The shipped reach/unlock paths are tested (reach.service.test.ts:190 proves the no-oracle 404; payer-reach.controller.test.ts:32 proves session-derived id), but agency_invites is brand new and has NO chokepoint yet: readOwnedById requires a row with a .payerId field — the design's agency_invites uses inviter_payer_id, so the helper must be fed row.inviter_payer_id explicitly (the generic <T extends {payerId}> shape won't match field-named inviter_payer_id). REQUIRED: a horizontal-authz build-blocker test (agent A cannot read/click/summarize agent B's agency_invites) and confirmation the ownership predicate keys on inviter_payer_id = session payer.id, before merge.

**Consent model:** Consent-before-processing is airtight BY CONSTRUCTION in this design, and I could not construct an agency-driven path that processes a non-consented worker. Verified chain: (1) the agency never holds a worker contact — bulk raw upload is correctly classified DEAD (invariant #2 + ADR-0010), so there is no 'uploaded worker' to process. (2) The only worker the agency can influence is one who self-onboards through the normal worker app (mock OTP -> consent), which writes worker_consents and emits consent.accepted BEFORE any profiling (invariant #6); the agency plays no part and the agency's invite carries only an opaque deep-link code. (3) Attribution attaches ONLY AFTER consent.accepted — agency_invites.invited_worker_id is nullable and 'set only after the worker's consent.accepted', and the design's own agency_invite.accepted event is 'emitted ONLY after consent.accepted'. This holds because the worker id the attribution references does not exist until the worker self-onboards. (4) employer_sharing is correctly kept as a SEPARATE second consent at the ₹40 unlock chokepoint — onboarding consent does NOT authorize disclosure. ONE thing to pin at build: agency_invites is an attribution INTENT record, NOT a processing trigger — confirm in code that writing/reading agency_invites never reads from the workers table or kicks any AI/profiling job (it must be a pure faceless signal). As designed it does not; just make that a tested invariant so a later 'enrich the referral' change can't quietly turn the intent record into a processing path.

**Faceless boundary:** FACELESS — no raw worker PII (phone/name/address/employer name) can reach the agency or any event/log under this design, confirmed against the actual reused code. (1) Dashboard/applicant reads go through reach.applicantsForOwnedJob (reach.service.ts:97), whose ApplicantRowDto carries only {workerId(opaque), rank, score, hot, pushEligible, components} — no PII (reach.service.ts:114). (2) Every reused event payload is ids/enums/counts only: feed.shown, unlock.* (UnlockRequested/Granted/Denied/CapExceeded/ContactRevealed — payloads.ts:589-636), payment.* (payloads.ts:638-664), job_posting.* (payloads.ts:503-536) carry opaque payer_id/worker_id/job_id and enums; the revealed phone/relay-destination/routing-token NEVER appears (payloads.ts:541-545, confirmed). (3) The only raw-phone decryption is the transient in-app-relay wiring inside the unlock reveal tx (unlocks.service.ts:293-305) which is discarded, never returned/evented/logged — and the agency reaches it ONLY via the already-shipped /payer/unlocks* (employer_sharing + caps + neutral no-oracle, reveal ownership check at unlocks.service.ts:252). The agency portal adds NO new disclosure path. (4) The new agency_invites + agency_invite.* events are ids/enums only by design (invited_worker_id is an opaque uuid). NET: faceless holds by construction, not by discipline. CAVEAT to enforce at build: the new agency_invite.created/agency_invite.accepted events must be authored via event-schema-change with the SAME ids/enums-only contract (no phone/name/campaign-as-PII); campaign must stay a stable non-PII code (mirror the invites.campaign rule, schema.ts:1140).

**KYC escalation:** STOP -> LEGAL. Agency KYC (bank/PAN/GST) is correctly classified LEGAL_MONEY_GATE and stays PARKED/capture-nothing: this ADR adds NO KYC/bank/PAN/GST column or table, and verified-current schema (payers ~L103) carries B2B contact PII under ADR-0004 at-rest discipline but NO financial-PII columns. This is the right call and must NOT drift. Conditions on the parked half before ANY KYC build: (1) lawful basis + consent/purpose copy + retention window + erasure story signed off by legal/DPDP (un-defer trigger #3) — financial PII is higher-sensitivity than the worker PII already gated. (2) KYC must live under workers-grade at-rest discipline (FORCE-RLS + REVOKE + encryption, ADR-0004) and must NEVER reach events/ai_jobs/audit_logs/logs/LLM input (invariant #2) — same boundary that protects worker PII, applied to financial PII. (3) No payout to an un-KYC'd agency, and payouts (module 7) are a DISTINCT §7 human gate for real outbound money on top of KYC. Until legal sign-off, nothing is captured — confirmed nothing in the build-now slice touches it. Escalate to human + security-engineer (privacy lead owns the authoritative financial-PII boundary call) the moment any KYC capture is proposed.

---

## Appendix D — Open questions / escalations (parked half)

For the parked half (escalate to product + human/legal; surface trade-offs, do not silently choose):

1. ATTRIBUTION PARAMS (product-ratify before any payout build) — 90d window first-touch vs last-touch? 25% of WHICH revenue basis (the ₹40 unlock, or a placement)? Is ₹500 a floor, a cap, or a flat per-conversion fee? All three are UNRATIFIED proposals in phase-2-agency-referral-payouts.md. The build-now agency_invites INTENT record is captured ids-only so it composes with whatever the model lands as, but the model itself blocks payouts.

2. KYC / DPDP (legal) — agency KYC is new high-sensitivity financial PII (bank/PAN/GST). What is the lawful basis, consent/purpose copy, retention window, and erasure story? It must live under the workers-grade at-rest discipline (ADR-0004) and never touch events/ai_jobs/audit_logs/logs. Legal + DPDP sign-off is a hard prerequisite (un-defer trigger #3); nothing is captured until then.

3. REAL OUTBOUND MONEY (§7 human gate) — payouts move real money OFF the platform, a distinct discipline from inbound (TD34). Needs: provider selection + key handling (staging-first, never committed) + spend guardrails + reconciliation + a §7 human authorization. No payout to an un-KYC'd agency. Presupposes real INBOUND payments are live first.

4. REAL COMMS / REAL PAYMENTS on the build-now slice — the slice ships on MockWhatsAppProvider (MESSAGING_ENABLE_REAL=false) and mock credits (PAYMENTS_ENABLE_REAL=false). Flipping either to real (provider keys, template approval, real spend) is a separate human gate; confirm we are NOT expected to flip them this phase.

5. agency_invites DB shape (build-time, database-architect) — sibling agency_invites table (recommended: zero blast radius on the shipped worker→worker invites funnel) vs a nullable inviter_payer_id column on invites with a one-of(inviter_worker_id, inviter_payer_id) CHECK. Both additive; needs the database-architect's call via safe-db-migration. Flagging because invites.inviter_worker_id is NOT NULL and invite.* payloads require inviter_worker_id, so reuse is impossible without breaking invariant #8.

6. New PII-free events — confirm agency_invite.created / agency_invite.accepted are wanted as NEW v1 events (vs deriving the funnel purely from agency_invites row reads). They are needed if the event spine must carry the attribution INTENT as an audited fact; they cannot reuse invite.* (payer inviter ≠ worker inviter, payload mismatch).

7. Surface confirmation — the agency portal is a role-aware view inside apps/payer-web (ADR-0019 Decision A), NOT a new app and NOT in apps/web ops console. Confirm web-app lock intent that agency demand = alpha, supply dashboard = fast-follow.

ESCALATION POSTURE: this ADR proposes ONLY the additive, faceless, mock, event-first demand slice. Anything in items 1–4 (KYC, attribution params, real money, real comms) expands scope / weakens a gate / commits real spend and is NOT decided here — it is surfaced for human/product/legal sign-off per CLAUDE.md §7.

---

## Amendment 1 (2026-07-23) — worker-side attribution LINKAGE wired (ungated slice only)

**Status:** ACCEPTED (owner sign-off 2026-07-23). Scope authorized: the **ungated attribution → funnel slice ONLY**. The payout model (Appendix D #1: `90d/25%/₹500`), KYC (Appendix D #2), real outbound money (Appendix D #3), and earnings analytics remain **PARKED / LEGAL_MONEY_GATE** unchanged — nothing here builds, ratifies, or presupposes them.

**What the owner ratified:** the worker-side invite-attribution **LINKAGE MECHANIC** (the TD48 un-defer precondition), NOT the payout model. The `agency_invites` INTENT record stays a faceless, ids-only, payout-free signal exactly as §d specifies; this amendment only gives it a live producer.

**Decision — how the previously-INERT attribution seams get a caller (closes TD48):**

1. **Unified worker-onboarding hook — `POST /referrals/attribute`** (new [`apps/api/src/referrals/`](../../apps/api/src/referrals/) module). Auth: `WorkerAuthGuard` — the `invited_worker_id` is ALWAYS the verified SESSION worker (never a body id; the XB-A rule), so a caller can only ever attribute THEMSELVES. Body: `{ code }` (12-hex). Response: a neutral `{ ok: true }` **regardless of outcome** (no-oracle — never reveals whether the code matched or who invited). This is the "fold agency codes into the invite/consent flow" option from the TD48 trigger — chosen over a second public per-namespace click/accept surface.

2. **Namespace disambiguation** (Appendix D #5 sibling-table consequence): `invites` (ADR-0020 worker→worker) and `agency_invites` (ADR-0022 agency→worker) share the opaque `/i/<code>` shape across two tables. Codes are random 12-hex → disjoint by construction. The service tries the **worker** seam (`InviteService.recordAccept`) first and falls through to the **agency** seam (`AgencyService.attributeWorkerToInvite`) ONLY on `unknown_code`; a KNOWN worker invite that can't attribute (self / already) is terminal.

3. **Consent gate (invariant #6) enforced in one place, fail-CLOSED.** `ReferralAttributionService` re-reads the worker's latest consent (`ConsentRepository.findLatestByWorker`, `revokedAt IS NULL`) BEFORE touching either seam — so the worker→worker path (whose `recordAccept` does not itself check consent) is now consent-gated too, satisfying Appendix-C C.1 #1 for BOTH namespaces. The hook is called by the client AFTER `consent.accepted`.

4. **Fail-safe.** Attribution is a best-effort side-signal; the service never throws to the caller and the controller ignores the outcome — a failure can never break worker onboarding.

5. **Events unchanged.** `invite.accepted` / `agency_invite.accepted` (both registered v1) are emitted by the existing seams — no new event, no payload change (Appendix D #6 answer stands).

6. **Client capture (Flutter, Android-first).** The `/i/<code>` deep-link is captured via a **custom scheme** (`badabhai://i/<code>`) into a pending-referral store, carried through login+consent, and consumed once by a fire-and-forget call to the hook after consent. Verified **App Links** (https + `assetlinks.json` on the real share domain) and **Play Install Referrer** (deferred-deep-link for fresh installs) are a deploy/infra follow-up (new TDs).

**Explicitly still deferred (unchanged by this amendment):** the payout accrual model + ledger, agency KYC, earnings/commission analytics (all Appendix D #1–#3), AND — within the funnel itself — the richer `installed → profile_completed → active` stages (the funnel stays `created / clicked / accepted`; deeper stages need new lifecycle signals) and a worker-reachable **agency click** path (the agency click route is agent-gated today, so the agency funnel's `clicked` stage has no worker producer). Logged as follow-up tech-debt.
