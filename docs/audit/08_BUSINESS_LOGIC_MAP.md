# 08 — Business Logic Map

Maps badabhai-platform's WORKER, PAYER, and ADMIN business flows to the files that implement them: controller → service → repository chains, the DTOs, the events, and — critically — where a **deterministic business rule** lives versus where `apps/ai-service` is called for extraction/generation only. Built by reading every service file in the modules listed below in full. Route/auth/class detail is not repeated here — see [03_API_INVENTORY.md](03_API_INVENTORY.md); this document is the *logic* layer underneath those routes.

**Convention used everywhere in this codebase**: `controller` (HTTP only, no data access) → `service` (business logic, emits events via `EventsService`) → `repository` (Drizzle, no business logic) + `*.dto.ts` (Zod) + `*.module.ts` (DI). Every service constructor lists its collaborators; that list *is* the dependency graph.

---

## 1. WORKER domain

### 1.1 Registration / OTP

`auth.controller.ts` → `auth.service.ts` + `otp.service.ts` → `workers.repository.ts`.

`POST /auth/otp/request` → `OtpService.requestOtp`. Business rules here are **entirely deterministic and config-driven, no AI**: per-phone resend cooldown, per-phone hourly send cap, and the OTP-5 **global daily send circuit-breaker** (`OTP_GLOBAL_MAX_SENDS_PER_DAY`, a `0` value = the worker-SMS kill switch — read live by `AdminKillSwitchService.buildStatus`). The code itself is never stored — only its HMAC in Redis, TTL-bound. SMS is `sms.provider.ts` (Fast2SMS — always real, no mock path).

`POST /auth/otp/verify` → `OtpService.verifyOtp` (constant-time compare, single-use) → on first verify, `AuthService.findOrCreateWorker` inserts the `workers` row and mints a session (`session.service.ts`). Events: `worker.otp_requested` / `worker.otp_verified` / `worker.created`.

Session/refresh rotation rules (reuse detection, refresh-token-as-credential) live in `session.service.ts` + `session-tiers.ts` — deterministic, table-driven, no AI.

### 1.2 Profile creation — chat/voice profiling interview

`chat.controller.ts` → `chat.service.ts` → `profiling/orchestrator.service.ts` (`ProfilingOrchestratorService.takeTurn`).

**This is the single most important "who decides" boundary in the WORKER domain**, explicitly documented as a Phase-8 cutover in code: *"Everything that DECIDES is pure and lives elsewhere (`next-question.ts`, `answer-capture.ts`, `predicate.ts`, `answer-map.ts`). This class does only the four things a pure function cannot: read Redis, resolve packs, apply the clock, and win or lose the write."*

The interview engine is a **deterministic finite-state question-pack driver**: `next-question.ts` (which question fires next, ask-ceilings, fixed de-escalation/hardship/closing reply text — closed sets, never LLM-generated), `predicate.ts` (branching logic), `answer-capture.ts`/`answer-map.ts` (what counts as an answer), `pack-registry.service.ts`+`pack-cache.service.ts` (the question packs themselves).

**AI involvement (assist only, never decision):** `llm-turn.service.ts` calls `apps/ai-service POST /profiling/turn` for **Phase-A LLM-led question phrasing**, and `lookahead.ts` predicts the next likely answer for latency — both are generation/prediction aids the orchestrator validates and can discard; neither picks which question is asked next nor decides the interview is complete (that's the closed `CompletionReason` set in `next-question.ts`).

Voice path: `voice.controller.ts` → `voice.service.ts` → upload to Supabase Storage → `voice-transcription.processor.ts` (BullMQ) → `apps/ai-service POST /voice/transcribe` (Sarvam STT) — transcription only, AI never decides anything from it; the transcript re-enters the same deterministic engine as typed answers.

### 1.3 Skills/experience/domain extraction

`profile-extraction.processor.ts` (BullMQ) → `apps/ai-service POST /profile/extract` (async, whole-conversation → draft profile fields) → `profiles.service.ts` validates + applies the AI's output. `POST /profile/confirm` is the worker-approval gate — nothing from the AI extraction lands on the profile until the worker (a human) confirms it; this is CLAUDE.md's "AI extracts, humans + deterministic rules decide" line drawn concretely.

Once confirmed, **match-skill derivation is a pure deterministic function**, not AI: `packages/match-engine/src/derive.ts` (`deriveWorkerSkills`) maps the confirmed `canonicalRoleId` + corpus `profileSkills` attribute ids through **closed-set taxonomy tables** (`packages/taxonomy`) into `mskill_*` ids — no embeddings, no model call. Wired from `match/worker-skills.service.ts` → `worker-skills.repository.ts`.

### 1.4 Resume generation

`resume.controller.ts` → `resume.service.ts` → `resume-generate.processor.ts` (BullMQ) → `apps/ai-service POST /resume/generate` (drafts summary/prose text) → `resume-render.processor.ts` → `resume-renderer.service.ts`.

The renderer is **deterministic PDF templating**, not AI: `ResumeRenderInput` is a fully-structured, **name-free** snapshot (`sourceProfileSnapshot`); `displayName` is decrypted server-side and injected only at render time (never logged/echoed — invariant #2). Trade-specific boilerplate (`trade-content.ts`, `hospitality-trade-content.ts`) and template selection (`templates/registry.ts`) are closed-set, hand-authored content — the AI never writes what appears on the PDF outside the one summary field it drafted.

### 1.5 Job feed / matching

**Two independent, both-real code paths, gated by `MATCH_V1_ENABLED`** — read `applications.service.ts`'s `getFeed` for the switch itself:

- **Matching V1 (live)** — `match/match-feed.service.ts` → `packages/match-engine`. **There is no score.** Ordering is one lexicographic comparator, `rankKeyCompare` (`rank.ts`): `effectiveTier ASC, skillMonths DESC, industryMonths DESC, lastWorkedAt DESC, lastActiveAt DESC, id ASC`. `effectiveTier` promotes a tier-2 (related-skill) worker to tier-1 ordering once `skillMonths >= tierFloorMonths` (config, default 36). The only presentation rule is `interleaveMaxPerCompany` (max N consecutive cards from one employer) — it reorders, never drops, rows.
- **Legacy path (flag off)** — `applications.repository.ts` `findOpenJobs`, a plain SQL scan, no ranking.

Reach — **who a posting is even shown to** — is resolved once, server-side, at publish time by `match/publish-reach.service.ts` (`PublishReachService.materialize`), never by the client: `packages/taxonomy`'s curated related-skill list decides tier-2 eligibility; a payer can only *untick* a suggested related skill, never remove a posted one. Widening a frozen reach set is an ops-only, append-only action.

`reach/reach.service.ts` is a **separate scored engine** (`packages/reach-engine`) used for the ops/payer "applicants for a job" reach preview and the "jobs for a worker" alternate view — **not** the same code as the worker's `GET /feed`. Its weighted score (`packages/reach-engine/src/scoring.ts`, `WEIGHTS` — role .35 / distance .20 / skills .15 / experience .15 / pay .10 / availability .05 / activity 0, CEO-locked ADR-0033) is also fully deterministic — closed-set skill-id equality only, no embeddings/LLM call.

The **actual paid applicant list a company sees** is `match/match-candidates.service.ts` (`MatchCandidatesService.listForPosting`) — distinct again: it reads `applications_rank_idx` pre-sorted by SQL using the same `rank.ts`/`tierFloorMonths` semantics, and only *labels* rows with `effectiveTier` for display — "the order is the SQL's, not this service's."

### 1.6 Applications (apply/skip)

`applications.controller.ts` → `applications.service.ts` → (V1) `match/match-apply.service.ts` (`buildSnapshot`). Business rule: **rank inputs are frozen ("snapshotted") onto the `applications` row at the moment of apply/skip→apply, and never recomputed** — a later profile edit must not silently reorder a list a payer already paid to see. The reach row is the authorization gate: no `job_reach` row for (worker, posting) → 404, identical to an unknown posting (no existence oracle). Events: `application.submitted` / `application.skipped`.

### 1.7 Visibility / reach

Covered under 1.5 (`PublishReachService`) — the same materialized `job_reach` rows gate both the feed and the apply authorization.

### 1.8 PIN auth

`pin.controller.ts` → `pin.service.ts` → `pin-hasher.service.ts` (Argon2-class hashing, never plaintext at rest) → `pin.repository.ts`. `POST /auth/pin/verify` deliberately has no separate auth guard — "the refresh token IS the credential" (ADR-0026) — a deterministic, non-AI rule enforced entirely in `pin.service.ts`.

### 1.9 Account deletion

`auth.controller.ts` (`/auth/account/delete/{request,confirm,cancel}`) → `account-deletion.service.ts`. Deterministic, config-free state machine (ADR-0026 Phase 5 + ADR-0031's 7-day grace amendment): `schedule` sets `workers.deletion_scheduled_at`; `cancel` clears it; the actual erasure runs **only from the sweep** (`account-deletion-sweep.processor.ts`, BullMQ) in a fixed, idempotent order. The pending-deletion marker is re-read as a freeze gate by `UnlockService` (§2.4) so a leaving worker stops surfacing to payers mid-grace-window — this is the one place WORKER and PAYER domain logic directly interlock.

---

## 2. PAYER domain

### 2.1 Signup/login

`payer-portal/payer-auth.controller.ts` → `payer-auth.service.ts` → `payers/payer-otp.service.ts` (email OTP via `zeptomail-email-login-channel.ts`) → `payers.repository.ts`. On successful signup, `match/free-tier.service.ts` (`grantQuietly`) grants `match_config.free_unlock_credits` (default 50) — **exactly-once under retry, enforced by a DB unique constraint on `idempotency_key = free_tier_grant:<payerId>`**, not application-level locking.

### 2.2 Job posting (incl. AI job-posting chat)

Manual form path: `job-postings.controller.ts` → `job-postings.service.ts` → `job-postings.repository.ts`; publish triggers `PublishReachService.materialize` (§1.5/1.7).

AI-assisted path: `payer-portal/job-posting-chat/job-posting-chat.controller.ts` → `job-posting-chat.service.ts` → `apps/ai-service POST /job-posting-chat/{opening,respond}` (per 03_API_INVENTORY.md: "one payer turn, deterministic engine, no LLM rephrase wired today"). The load-bearing rule, stated directly in the service docstring: **this is a front door, not a second create path** — `publish()` validates the AI-assembled draft against the exact same `PayerCreateJobPostingSchema` the manual form uses and hands it to the same `JobPostingsService.createForPayer`, which is the only place `job_posting.created` is emitted.

### 2.3 Pricing / plans / boost / credits

**`packages/pricing`** is the single deterministic pricing core (ADR-0013). `resolvePrice` (`resolve.ts`) is pure: same `(catalog, request)` → same `Quote`, no I/O, no clock unless supplied. Fail-closed guarantees baked in: unknown product/tier → `{ok:false}` never a `$0`; invalid/expired/over-cap coupon is **ignored** (never blocks a purchase); `finalInr` clamped ≥ `catalog.floorPriceInr`; at most one offer **then** one coupon.

Wiring: `pricing.service.ts` (`getActiveCatalog` — fails closed to `DEFAULT_CATALOG` on any invalid stored row) called from three purchase surfaces, all sharing the one engine: `posting-plans.service.ts` and `unlocks/payment-gateway.ts` (`resolvePack`). Shipped defaults (posting ₹1000/₹2500, boost ₹499/₹999/₹1799, unlock ₹40/credit with a real 20% volume discount on the 1000-pack, capacity ₹5000/₹12000) live in `packages/pricing/src/defaults.ts`.

Ops price edits: `pricing.controller.ts` `PUT /pricing/catalog` → `updateCatalog` — re-validates via `safeParseCatalog` before publishing a new revision; emits `pricing.changed` with **field KEYS only, never old/new ₹ values** (invariant #2 applied to money, not just PII).

Capacity enforcement (ADR-0016) is its own deterministic gate: buying a plan counts the payer's currently-active vacancies under a `pg_advisory_xact_lock` and writes `status='active'` only within the payer's allowance.

### 2.4 Applicant unlocks / reveals

`payer-portal/payer-unlocks.controller.ts` (+ ops-legacy `unlocks/unlocks.controller.ts`) → `unlocks/unlocks.service.ts` (`UnlockService` — 1,167 lines, the single most heavily-invariant-documented service in the repo). This is the "single fail-closed disclosure chokepoint" (ADR-0010 §D4) — **the only writer of `unlocks`/`unlock_routing` in the whole codebase**.

Deterministic rules, all config-driven, none AI: worker-protection caps (`UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY` default 5, `UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK` default 10, `UNLOCK_MAX_ATTEMPTS_PER_UNLOCK` default 3 — atomic under a per-worker Postgres advisory lock); fixed gate ordering (credit precondition → consent → pending-deletion freeze → caps → payment+grant, both-or-neither in one transaction), every deny branch byte-identical (no-oracle); the raw phone is decrypted at exactly one line and never returned/logged/evented — only an opaque `relay_handle` crosses the boundary; `payer.credits_exhausted` fires on the exact `balance > 0 → 0` transition, read from the atomic decrement's own return value.

Razorpay: `unlocks/razorpay-webhook.controller.ts` + `payment-gateway.ts` — webhook is the source of truth; `PAYMENTS_ENABLE_REAL` defaults false (mock only in alpha).

### 2.5 Team/org members

`payer-portal/payer-org-members.controller.ts` / `payer-org-invites.controller.ts` → `payer-org-members.service.ts` → `payers/payer-orgs.repository.ts`, gated by `payer-org-role.guard.ts`. Deterministic membership/role rules, no AI.

### 2.6 Agency-specific flows

- **Invites/referrals**: `agency/agency-invites.controller.ts` → `agency-invites.repository.ts`; batch-cap and no-per-invite-oracle rules have dedicated tests.
- **KYC**: `agency/agency-kyc.service.ts` (+ ops side `agency-kyc-ops.controller.ts`) → `agency-kyc.repository.ts`. Encrypted KYC columns — one of two places raw-PII-adjacent data is permitted outside `workers`.
- **Payouts**: `agency/agency-payout.service.ts` — formula `Math.floor(AGENCY_PAYOUT_UNLOCK_BASIS_INR × AGENCY_PAYOUT_RATE_BPS / 10000)` per qualifying granted unlock (owner-ratified default ₹40 × 2500bps = ₹10/unlock), idempotently accrued off the **real** `unlocks` table (`ON CONFLICT (source_unlock_id) DO NOTHING`). `requestPayout` is a two-gate chokepoint: `AGENCY_PAYOUTS_ENABLED` flag AND KYC verified AND requestable total ≥ threshold — mock ledger, no disbursement path exists yet.

---

## 3. ADMIN domain

### 3.1 Authentication / MFA

`admin/admin-auth.controller.ts` → `admin-auth.service.ts` + `admin-otp.service.ts` + `admin-mfa.ts`/`admin-mfa.store.ts` → `admin.repository.ts`. Guards: `admin-auth.guard.ts` (session) + `admin-roles.guard.ts` (capability-based — `admin-capabilities.ts` is the closed capability enum every route checks against).

### 3.2 Worker/payer/job-posting entity management

`admin/admin-entities.controller.ts` → `admin-entities.service.ts` → `admin-entities.repository.ts`. Deliberately thin — validation at the Zod pipe, PII projection at the repository select list, authorization at the guards, and **no events**, because a read is not a state change. Mutating actions route through `admin/admin-actions.controller.ts` → `admin-actions.service.ts` with its own atomicity test file.

### 3.3 PII reveal

`admin/admin-pii-reveal.controller.ts` → `admin-pii-reveal.service.ts` — R24's most sensitive route (default-OFF flag `ADMIN_PII_REVEAL_ENABLED`, 404 while off). **Fixed five-step control pipeline, in order, fail-closed at every step**: (1) flag check, (2) per-admin rate cap in Redis (fail-closed on Redis error), (3) lookup with a neutral 404 shared by "unknown" and "denied" (no enumeration oracle), (4) **audit-before-decrypt** — the `admin.pii_viewed` event is emitted and *awaited to commit* before any plaintext is computed, (5) decrypt at the boundary — plaintext exists only in the response body, never logged/cached/evented.

### 3.4 Finance / credit ledger

`admin/admin-finance.controller.ts` → `admin-finance.service.ts` → `admin-finance.repository.ts` — read-only aggregation over `payer_credits`/`credit_ledger`/`payment_orders`, no events.

### 3.5 Events / audit trail

`admin/admin-events.controller.ts` → `admin-events.service.ts` → `admin-events.repository.ts` — reads the `events` table that every other flow in this document writes to via `EventsService.emit`, which validates every payload against `packages/event-schema`'s registered Zod schema before persisting.

### 3.6 Kill-switch

`admin/admin-kill-switch.controller.ts` → `admin-kill-switch.service.ts`. By explicit design (OQ-6), this is **display + safe-direction pause-intent only** — it reads existing `packages/config` gates into a status snapshot and emits a value-free audit event on request — **it never mutates a flag, writes config, or enables anything; there is no such code path.**

---

## 4. Deterministic core vs AI-assisted — the confirmed split

| Package / seam | What it decides | AI involved? |
|---|---|---|
| `packages/match-engine` (`rank.ts`, `derive.ts`, `config.ts`) | Worker feed order (Matching V1), skill-months, tier promotion | **No.** Pure functions, zero I/O, zero randomness. |
| `packages/reach-engine` (`scoring.ts`, `ranking.ts`) | Payer applicant-list order, worker-jobs-feed alt view | **No.** Weighted deterministic scoring, closed-set skill equality only. |
| `packages/pricing` (`resolve.ts`) | Every ₹ a payer is charged | **No.** Pure, fail-closed. |
| `profiling/next-question.ts`, `predicate.ts` | Which question the worker is asked next, when the interview ends | **No.** Deterministic finite-state pack driver. |
| `unlocks/unlocks.service.ts` | Whether a payer gets a worker's contact | **No.** Fixed gate order, DB-atomic caps. |
| `agency/agency-payout.service.ts` | Whether/how much an agency gets paid | **No.** Config-formula + two-gate chokepoint. |
| `apps/ai-service POST /profiling/turn`, `/profile/extract` | Question **phrasing**, transcript → **draft** profile fields | **Yes** — output validated/confirmed by a human or deterministic schema before it can change state. |
| `apps/ai-service POST /resume/generate` | Résumé **summary prose** only | **Yes** — every other slot in the renderer is structured, non-AI data. |
| `apps/ai-service POST /job-posting-chat/respond` | Payer-chat turn content | **Deterministic today** per 03_API_INVENTORY.md — the AI seam exists but the live engine is rule-based. |
| `apps/ai-service POST /voice/transcribe` | Speech → text | **Yes** (Sarvam STT) — output re-enters the same deterministic interview engine as typed text. |

The one place a match/skills *value* touches an LLM at all is **upstream, at profiling extraction time** — never at ranking/pricing/unlock-decision time. `packages/reach-engine/src/scoring.ts`'s own comment states this as an explicit invariant: "no embeddings, no similarity, no model call ever ranks."

---

## 5. Worked examples — "if I change X, which files are affected?"

### 5.1 "I want to raise the daily-reveal cap from 5 to 8"

Single config default: `packages/config/src/server.ts` (`UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY: z.coerce.number()...default(5)` → `8`) + its assertion test in `config.test.ts`. **No change needed** in `unlocks.service.ts` — `checkCaps` reads the config live, never a copied literal. Runtime override needs no code change either — it's an env var. If the intent is instead per-payer-tunable rather than global, that's a much bigger change requiring a new DB-backed config row, a migration, and an admin kill-switch display-text update.

### 5.2 "I want the boost_30 price to be ₹1999 instead of ₹1799"

`packages/pricing/src/defaults.ts` — the `job_boost` `boost_30` tier's `priceInr: 1799` is the **only** literal to change, plus its golden-price test assertion. No change to `resolve.ts` (generic over the catalog) or `posting-plans.service.ts` (resolves live). If the change is meant as a live ops price edit rather than a redeploy, the lever is `PUT /pricing/catalog` — no code deploy required at all, either path fail-closed. **Note**: the displayed price on `apps/payer-web` and `apps/web` is a known live duplication bug (07_DUPLICATION_AUDIT.md DU-5, one formats with digit grouping, one doesn't) — changing the backend price doesn't touch either frontend's formatting code.

### 5.3 "I want the tier-floor to promote a related-skill worker at 24 months instead of 36"

Fans out further than pricing because the value is read in two independently-maintained places that must agree: `packages/match-engine/src/config.ts` (`tierFloorMonths` default 36→24), several `rank.ts`/`rank.invariants.test.ts`/`worked-examples.test.ts` boundary tests must be re-derived, `match/match-config.service.ts` (the live DB-row path, mirroring `pricing_catalog`'s pattern), `match/match-candidates.service.ts` (**re-derives `effectiveTier` for display only** — must stay in sync with what the SQL actually sorted by; its own comment: "if this service sorted, there would be three implementations of one rule instead of two"), and `match/match-feed.repository.ts` — the SQL query must be parameterized on `tierFloorMonths`, not a hardcoded `36` in a `CASE` expression — **this was not directly verified in this pass and is worth a follow-up grep before shipping.**

**Escalation note**: `tierFloorMonths` was set by an explicit **owner ruling** dated 2026-07-31 (documented in `rank.ts`'s header: "no shop supervisor would accept" a strict ordering below this floor). Changing a CEO/owner-ratified matching threshold is a business-logic decision, not a pure engineering one — it should go back through the same ratification path, not just a config-default PR.

---

## 6. What this map deliberately does not re-derive

Route method/path/auth/class/test-coverage detail — see [03_API_INVENTORY.md](03_API_INVENTORY.md). Component-level data-flow / external-provider edges — see [docs/architecture/API_ROUTE_MAP.md](../architecture/API_ROUTE_MAP.md). Security control detail on the PII-reveal and unlock chokepoints — see [15_SECURITY_AUDIT.md](15_SECURITY_AUDIT.md).
