# Architecture Log

A chronological record of BadaBhai's architectural **state and changes** — the
"how did we get here" companion to the always-current
[architecture overview](../architecture/overview.md). Append an entry whenever the
shape of the system changes (new component, new seam, new contract surface, a
boundary moved).

---

## 2026-07-14 — Skills-taxonomy vocabulary layer + canonicalization seam (ADR-0030, TAX-1..4 + fork-B)
- **New vocabulary tables** (migration 0037, #212): `skill` (immutable `skill_id`, status
  active/provisional/deprecated), `skill_alias` (embedded alias variants, denormalized
  `domain_id`, `embedding vector(768)` + a **second HNSW cosine index**), `unresolved_phrase`
  (pseudonymized below-floor miss queue). All three RLS-spined (FORCE + REVOKE, in
  `LOCKED_TABLES`). pgvector was already enabled (0001); 768 stays the house dimension.
- **New AI module** [`app/ai/embeddings.py`](../../apps/ai-service/app/ai/embeddings.py)
  (#214): `embed_text` pseudonymizes FIRST (SG-2, fail-closed), deterministic MOCK vector by
  default, real Gemini `embedContent` §7-gated (SG-4: master flag + key + `skill_embedding`
  allowlist). Batch `embed_aliases` over an **`AliasStore` Protocol** — the ai-service stays
  DB-free by design.
- **New canonicalization seam** [`app/ai/canonicalize.py`](../../apps/ai-service/app/ai/canonicalize.py)
  (#215): `canonicalize_skill(phrase, domain_id) → {skill_id, score} | UNRESOLVED` —
  pseudonymize → embed → domain-scoped nearest-alias → floor gate (0.82, inclusive). SG-3:
  assigns ids from the closed alias set, **never invents, never ranks** (invariant #4: no
  skills signal in RANK). Wired into `map_rich_to_legacy` behind
  `SKILL_CANONICALIZE_ENABLED=false`; the flag alone is inert (TD65 activation chain).
- **fork-B boundary decision (owner, 2026-07-14):** the `skill_alias` vector read/write
  lives in a **`packages/db` runner** (owner connection, `pnpm db:embed:skills`) calling a
  new ai-service endpoint `POST /embeddings/skill-alias` over HTTP; a psycopg client inside
  the ai-service was REJECTED. Contract surface `SkillAliasEmbed*`/`SkillCanonicalization*`
  mirrored Zod↔Pydantic in [`packages/ai-contracts`](../../packages/ai-contracts/) (invariant #7).
- **References:** [ADR-0030](../decisions/0030-embedding-skill-canonicalization.md) ·
  [roadmap](../ai/skills-taxonomy-roadmap.md) (TAX-5..9 pinned) · TD64/TD65 (launch gates).

## 2026-06-24 — BUG-2 staging demand-loop PASS (backend proof DONE; pending §1.3 + formal close)
- **What happened:** the guarded CD workflow
  ([staging-demand-verify.yml](../../.github/workflows/staging-demand-verify.yml)) ran **GREEN** on
  `main` (manual `workflow_dispatch`, **run #7**, commit `710846a`, ~3m) against a **disposable
  non-prod** Supabase staging DB. `db:verify:demand` printed its PASS line with all **six** events
  recorded: `feed.shown`, `job_posting.purchased`, `payment.authorized`, `payment.captured`,
  `unlock.granted`, `contact.revealed`. Seed fixture: worker `5eeded00…001`, payer `5eeded00…004`
  (credits=25), open posting `5eeded00…006`. **MOCK-only** (`PAYMENTS_ENABLE_REAL` /
  `AI_ENABLE_REAL_CALLS` / `MESSAGING_ENABLE_REAL` all `false`).
- **This clears the BACKEND half of BUG-2** — the unlock/contact/payment demand loop is now proven
  end-to-end on staging (previously **0** such events had ever been recorded). Unblocks payer
  runtime proofs + the weekly-paid-unlocks dashboard.
- **Enabling fix (PR #136):** the workflow had built the whole monorepo, so `next build` of
  `apps/web` failed under `NODE_ENV=development`; the build is now scoped to
  `pnpm --filter "@badabhai/api..." build` (skips the Next.js apps the loop doesn't need). The real
  CI blocker during bring-up was a **stale/wrong password in the GitHub `staging`-environment
  `DATABASE_URL` secret** (CI reads ONLY the environment secret, not Supabase/local); a Supabase
  *branch* DB is also never empty (clone of parent → `already exists`) — a fresh standalone project
  or a `drop schema public/drizzle cascade` is the clean target.
- **BUG-2 still OPEN — pending ONLY:** (1) a human **report** of this staging PASS, and (2) the
  **§1.3 human click-path** (UI/PII proof) in
  [ops-employer-workflow-runtime-verification.md](../qa/ops-employer-workflow-runtime-verification.md).
  The verify path still rides the OPS surface (`InternalServiceGuard` + body `payer_id`); the R16
  session-auth forward-port stays deferred as [TD50](./tech-debt-register.md).

## 2026-06-23 — BUG-2 staging demand-loop deploy SCAFFOLDING landed (BUG-2 stays OPEN)
- **What landed (ADDITIVE, deploy-side only):** a copy-paste **deploy runbook**
  ([bug2-staging-demand-deploy-runbook.md](../ops/bug2-staging-demand-deploy-runbook.md)) —
  provision → secrets → migrate → seed → start → verify → rollback, with an env-var table
  and a 4-row failure-triage table — plus a **manual-only, guarded/inert CD workflow**
  ([staging-demand-verify.yml](../../.github/workflows/staging-demand-verify.yml),
  `workflow_dispatch` against a `staging` GitHub environment, runs migrate→seed→start→verify
  once a human wires it). Both cross-link the existing verdict doc
  ([ops-employer-workflow-runtime-verification.md](../qa/ops-employer-workflow-runtime-verification.md)).
- **What did NOT change:** the seed/verify **tooling** itself
  (`packages/db/src/{seed-demand.ts,verify-demand.ts,crypto.ts}` + the
  `db:seed:demand` / `db:verify:demand` scripts) is **already on main** (PR #105) — this
  scaffolding only makes the §7 human run **turnkey**; it does not add tooling and does not
  execute staging. MOCK-only is unchanged (`PAYMENTS_ENABLE_REAL` / `AI_ENABLE_REAL_CALLS` /
  `MESSAGING_ENABLE_REAL` all `false`; flipping any is a separate CLAUDE.md §7 gate).
- **BUG-2 stays OPEN.** It closes ONLY when a human reports a staging PASS = a green
  `db:verify:demand` (the six events `feed.shown`, `job_posting.purchased`,
  `payment.authorized`, `payment.captured`, `unlock.granted`, `contact.revealed`) AND the
  §1.3 human click-path, both against a **disposable non-prod** DB. Provisioning infra +
  holding secrets + running the loop remain a human CLAUDE.md §7 action (touches infra +
  real PII at reveal). Detail / current status:
  [ops-employer-workflow-runtime-verification.md](../qa/ops-employer-workflow-runtime-verification.md)
  (TL;DR + §1.1a on-deploy sequence). Cross-link the deferred real-money / real-provider /
  per-payer-auth residuals: [R16](./risks-register.md)–[R21](./risks-register.md),
  [TD33](./tech-debt-register.md)/[TD34](./tech-debt-register.md)/[TD35](./tech-debt-register.md).

## 2026-06-22 — Agency Supply Portal backend landed (ADR-0022)
- **New principal DIMENSION: a vertical-authz seam layered on the tenant guard.**
  Until now payer authz had one axis — `PayerAuthGuard` proves *which* payer
  (tenant identity, session-derived `payer_id`) and `assertPayerOwns`/`readOwnedById`
  (`apps/api/src/payers/payer-scope.ts`) enforce *horizontal* isolation (payer A
  cannot touch payer B's rows). ADR-0022's "Agent-Only" role model adds a SECOND,
  orthogonal axis: **`PayerRoleGuard` + `@PayerRoles('agent')`**
  ([`apps/api/src/payers/payer-role.guard.ts`](../../apps/api/src/payers/payer-role.guard.ts))
  — *what role* the authenticated payer holds. It is **fail-closed**: an undecorated
  route is a no-op, an absent `req.payer` → 401, a `role` that is null or out-of-set
  → 403, and it **never defaults to `agent`**. `role: PayerRole | null` is now carried
  on `AuthenticatedPayer` (resolution order: session claim → `payers`-row fallback →
  null). This is **distinct from `assertPayerOwns`** (horizontal/tenant authz, which is
  unchanged) — role is vertical, ownership is horizontal; every agency route stacks
  BOTH (`@UseGuards(PayerAuthGuard, PayerRoleGuard) @PayerRoles('agent')`). This is the
  first real role gate over the ADR-0019 payer account, which previously carried no role
  claim (cross-link [TD33](./tech-debt-register.md)/[R16](./risks-register.md), the
  `PayerAuthGuard` launch gate this builds on).
- **New module: agency demand slice (`apps/api/src/agency/*`, controller `payer/agency`).**
  An agency is an existing `payers` row with `role='agent'` (ADR-0019 account REUSED — no
  new principal). The slice is the SAME additive, faceless demand loop an employer gets,
  scoped to the agent role:
  - **Demand on `jobs.payer_id` (full loop):** `POST`/`GET /jobs`, `GET`/`PATCH /jobs/:jobId`,
    `POST /jobs/:jobId/close`, `POST /jobs/:jobId/pause` (pause == close-equivalent;
    `JobStatus` stays `open|closed`). Tenancy is the SESSION payer (XB-A), never a
    body/param; unknown-vs-not-owned → identical neutral 404 (no-oracle).
  - **Faceless invite mint:** `POST /invites` writes an `agency_invites` row and returns
    an OPAQUE code only — optional non-PII campaign tag, NO phone/name/email/worker-id.
    Per-payer hourly mint cap via `PayerDisclosureRateLimit` (fail-closed on a Redis outage).
  - **`POST /invites/:code/click`** — an agency-scoped MOCK funnel stub, distinct from the
    public ADR-0020 invitee click.
  - **`GET /referrals/summary`** — AGGREGATE-ONLY funnel counts with a k-anon floor
    `MIN_BUCKET=5` (counts below the floor suppressed to 0); no per-invitee oracle
    (closes ADR-0022 Appendix-C #2).
  - **Applicants REUSE the shipped `/payer/reach/jobs/:jobId/applicants`** (the faceless
    ranked reach feed) — no new applicant endpoint, no new disclosure path.
- **New data shape: a faceless `agency_invites` table** (migration
  `0025_first_black_bolt.sql` — renumbered from 0024 at merge, since #126 had taken
  0024; regenerated against the cumulative schema). Columns:
  `id`, `inviter_payer_id` (FK `payers` cascade), `code` (unique), `invited_worker_id`
  (FK `workers` set null, nullable), `channel`/`status` enums, optional `campaign`,
  timestamps. **NO KYC/money columns.** FORCE RLS + REVOKE ALL
  (public/anon/authenticated/service_role) — same lock as the rest of the spine (TD20).
- **New event family: 5 additive v1 events, PII-FREE.** `job.created`, `job.updated`
  (carries changed-field **KEYS**, never values), `job.closed`, `agency_invite.created`,
  `agency_invite.accepted` (the invite **code is never carried**). New event domains
  `job` and `agency_invite`. **Event-schema registry count: 69 → 74.** No shipped
  payload mutated (invariant 8).
- **Consent-attribution seam is INERT/unwired.** `AgencyService.attributeWorkerToInvite`
  is an INTERNAL seam that NO-OPs unless an active `worker_consents` row exists
  (`findLatestByWorker` + `revokedAt` null). It is EXPORTED but currently has NO caller —
  inert until wired into the worker consent-accept flow, a tracked fast-follow
  ([TD48](./tech-debt-register.md)). **No attribution occurs today** (satisfies the
  consent-before-attribution build-blocker by construction — no write path is live yet).
- **Config:** new `AGENCY_INVITE_MINT_MAX_PER_HOUR` (default 60) in `packages/config`.
- **Posture (mock + staging-only).** Dual security gate (security-engineer +
  security-reviewer) returned BOTH PASS (zero Critical/High); all 5 ADR-0022 Appendix-C
  conditions confirmed; an end-to-end vertical-authz test
  (`apps/api/src/agency/agency-role-authz.test.ts`) is included. Verification on `main`
  base: apps/api typecheck clean; 722 api tests pass; 67 event-schema tests pass; eslint
  clean; build green.
- **Frontend WIRED (fast-follow).** The payer-web agency dashboard now consumes the LIVE
  `/payer/agency/*` endpoints — vacancy CRUD (list/create/edit/pause/close), the faceless
  invite mint, and the aggregate k-anon referral funnel — reusing the existing
  `requireAgent()` page+action gate, `payerFetch` (Bearer-only, XB-A), and
  `assertNoAgencyPII` render-boundary guard; no new auth/transport/PII seam. The EMPLOYER
  `posting_plans` mock + the parked payouts/KYC page are untouched. (Earlier this was HELD
  pending reconciliation with the parallel #123/#107 agency frontend; the reconciliation
  kept that frontend's dashboard shell and swapped its mock vacancy/invite/funnel seams for
  the LIVE ones.) KYC / payouts / real comms-payments / matching / outcome-tracking remain
  DEFERRED (§8).
- See [ADR-0022](../decisions/0022-agency-supply-portal.md),
  [TD48](./tech-debt-register.md), and [TD33](./tech-debt-register.md)/[R16](./risks-register.md).

## 2026-06-19 — AI spend ledger moved to a shared Redis store (TD27 final sub-item)
- **Redis activated for the AI service — stack-locked, no new ADR.** CLAUDE.md §3
  already names Redis as the locked cache with deferred wiring; this entry records
  the *activation* of that wiring for the AI-service spend ledger, not a new
  datastore decision. The seam is unchanged — the `LlmAdapter`/`AIRouter` boundary
  and the pseudonymization gateway are untouched; only the **backing store** of
  `cost_tracker.SpendLedger` changes.
- **Why: caps must enforce GLOBALLY across Uvicorn workers.** The per-process
  singleton ([`cost_tracker.py`](../../apps/ai-service/app/ai/cost_tracker.py)) made
  daily / cumulative / per-user INR caps *per-worker* — N workers could each spend up
  to the cap. This is the last open [TD27](./tech-debt-register.md) sub-item and a
  hard prereq for the (separate, human-gated) real-LLM prod flip. Cross-link
  [R6](./risks-register.md).
- **New seam: a `SpendStore` backend behind the name-stable `SpendLedger` facade.**
  Two impls selected by whether `REDIS_URL` is set: `InProcessSpendBackend` (today's
  `threading.Lock` logic — the dev/test/no-`REDIS_URL` default, keeps CI Redis-free)
  and `RedisSpendBackend` (`redis.asyncio`). Public method names are preserved
  (`would_exceed_spend`/`record_spend`/`try_consume_retry`/`snapshot`/`reset`/
  `get_ledger`); they become **async** (router.run is async — a sync client would
  block the event loop).
- **Decision: atomic reserve → reconcile → refund (closes the documented overshoot).**
  `would_exceed_spend` changes from check-only to an **atomic check-AND-reserve** (a
  single Lua script: check per-user→daily→cumulative, then INCRBYFLOAT all counters by
  the worst-case projected cost, only if all pass). This closes the bounded
  check-then-act overshoot flagged by the security review. After the call the router
  **reconciles**: `record_spend(reserved, actual)` refunds `reserved − actual` on
  success and the **whole** reserve (`actual=0.0`) on failure/abort — so the
  mock-fallback path no longer leaks a reservation. (Modeled with the existing two
  methods + one new failure-path `record_spend(reserved, 0.0)` call — no new public
  method.)
- **Fail-closed posture (mirrors `AI_ENABLE_REAL_CALLS`/`PAYMENTS_ENABLE_REAL`).**
  `REDIS_URL` unset ⇒ deliberately in-process (NOT a failure). With Redis configured
  but **unreachable**: reserve returns a block reason (`spend_store_unavailable`) ⇒
  real call blocked ⇒ mock fallback (an unverifiable cap never permits a real spend);
  reconcile/refund errors leave the worst-case **reserved** (stricter) and log
  PII-free — the request still returns (router never raises).
- **Decision: retry budget stays per-process.** It is a per-worker circuit-breaker
  against a failing provider, not a money guardrail; the spend exposure of retries is
  already bounded by the now-global atomic spend reserve (at most one billable success
  per candidate). Only the **spend** caps move to Redis.
- **PII-free keys + values.** `aispend:daily:{UTC_DATE}` (TTL to next UTC midnight),
  `aispend:total` (no TTL), `aispend:user:{UTC_DATE}:{worker_ref}` (TTL like daily) —
  INR amounts, counts, the UTC date, and the **opaque** `worker_ref` only; never
  content, tokens, or a worker-identifying id. UTC-day rollover is structural via the
  date in the key name. **No `ai.*` / `ai.spend_cap_exceeded` payload changed**
  (invariant 8); `AI_ENABLE_REAL_CALLS` stays OFF (separate human gate).
- See [TD27](./tech-debt-register.md), [R6](./risks-register.md), and the real-LLM
  [go/no-go](../ai/real-llm-flip-go-no-go.md).

## 2026-06-15 — Contact Unlock + Reveal Stream A backend landed (ADR-0010)
- **New contract surface: the routed-disclosure monetization spine.** Contact
  Unlock is the one feature that deliberately discloses a worker's contact channel
  to a paying party — the highest-risk PII path in the product. Stream A (backend
  core) landed behind a written, human-gated contract; **ADR-0010 Accepted
  (2026-06-15, Prakash)** with the F-1..F-7 controls folded in, and the build was
  authorized only post-sign-off + after the [PII-disclosure threat model](../security/contact-unlock-threat-model.md)
  passed (bb-security-review = **PASS**; the one High finding **F-A** — an
  unknown-worker FK-500 oracle — was fixed + has a CI regression test).
- **New data shape: four additive, PII-FREE tables + one additive column.**
  `unlocks` (one routed-contact grant — `payer_id` opaque/no-FK, `worker_id` → the
  only identity join, `status`/`routing_token_ref`/`reveal_count`/`expires_at`),
  `payer_credits` (mock balance), `credit_ledger` (append-only credit movements),
  `unlock_routing` (token → `worker_id` + channel enum + expiry, **schema-proven
  phone-free**), plus `jobs.payer_id` (opaque, nullable). **No phone, name, proxy
  number, or contact string in any column** — "PII lives only in `workers`" holds.
  Migration `0014` (additive; RLS-locked via REVOKE per TD20). **Table count:
  16 → 20.**
- **New event family: 8 additive v1 events, PII-FREE (ids/enums/counts only).**
  `unlock.requested|granted|denied|cap_exceeded`, `contact.revealed`
  (**channel KIND only** — `in_app_relay`/`proxy_number`, never the destination),
  `payment.authorized|captured|failed` (every one `real_call: false` in alpha).
  New event domains `unlock`/`contact`/`payment` + the `unlock` subject; the
  `payer` actor already existed. **No ADR-0006/0009 payload mutated** (invariant 8).
- **New consent purpose + a fail-closed disclosure gate.** `employer_sharing`
  added to `CONSENT_PURPOSES` (the enum already reserved it); a purpose-scoped
  sibling of `ConsentGuard` gates every reveal, fails closed, and is revocable —
  disclosure to a payer is a *distinct* DPDP purpose from profiling.
- **New seam: a single fail-closed chokepoint.** `UnlockGuardService` is the only
  writer of `unlocks` and the only resolver of `routing_token_ref`; the ordering is
  **consent → caps → payment → grant → routed-reveal**, each gate denying and
  disclosing nothing on failure (no-oracle neutral response). The raw phone is read
  (`PiiCryptoService.decrypt`) **only** at the routed-reveal step, server-side, once,
  handed to the in-app relay, and discarded — never in an event/log/response.
- **Alpha posture (interim, flagged):** payer routes ride `InternalServiceGuard`
  (no per-payer auth yet — `PayerAuthGuard` is a launch gate, [TD33](./tech-debt-register.md)/[R16](./risks-register.md));
  reveal is **in-app relay only** (no telephony provider, no raw number leaves
  BadaBhai — [R18](./risks-register.md)); payments are a **mock credit ledger**
  (`PAYMENTS_ENABLE_REAL=false` — [TD34](./tech-debt-register.md)/[R17](./risks-register.md)).
  **226 API tests + e2e green.**
- **Next, gated streams:** payer UI (Stream B), real Razorpay credit-pack purchase
  ([TD34](./tech-debt-register.md)), and `PayerAuthGuard` ([TD33](./tech-debt-register.md))
  — each a separate gated step. DPDP `employer_sharing` notice copy + a
  retention/erasure policy ([R19](./risks-register.md)/[TD35](./tech-debt-register.md))
  must land before any non-mock disclosure.
- See [ADR-0010](../decisions/0010-contact-unlock-and-reveal.md) and the
  [threat model](../security/contact-unlock-threat-model.md).

## 2026-06-15 — Alpha swipe-to-apply surface landed (ADR-0009)
- **New contract surface: a sanctioned scoped producer for the ADR-0006 events.**
  The `feed.shown` / `application.submitted` / `application.skipped` v1 events
  (defined "contract ahead of producer" in ADR-0006) now have a real, honest
  producer. **No event payload version bump** — alpha passes seed-order `rank` and
  lets `score`/`hot` take their safe defaults (`0` / `false`), the truthful values
  for an unranked surface (the AI-never-ranks pillar is untouched, invariant 4).
- **New data shape: two additive, PII-free tables.** `jobs` (seeded, coarse —
  `trade_key`/`title`/`city`/`area`/`status`; **no employer name, pay, or contact**)
  and `applications` (`job_id`/`worker_id` FKs, `action`/`reason`/`source_surface`/
  `rank`; UNIQUE `(worker_id, job_id)`, last-write-wins upsert; CHECK `reason` only
  on skip). The only identity reference is `applications.worker_id` → `workers`;
  **"PII lives only in `workers`" holds.** Migration `0012_nosy_retro_girl.sql`
  (additive; not yet applied to a shared DB — needs sign-off per CLAUDE.md §7);
  idempotent seed `packages/db/src/seed-jobs.ts` (17 jobs across all 15 alpha
  trades). **Table count: 14 → 16.**
- **New API module + a new shared guard.** `apps/api/src/applications` —
  `GET /feed`, `POST /applications/:jobId/apply|skip` (worker, consent-gated,
  idempotent) + `GET /jobs/:jobId/applicants` and `GET /workers/:workerId/applications`
  (`InternalServiceGuard`, PII-free projections). New reusable `ConsentGuard`
  (`apps/api/src/auth/consent.guard.ts`) — the first "require active consent before
  this action" primitive (resolves ADR-0009 OQ-1).
- **New seam, clients:** read-only ops applicant views in `apps/web`
  (server-only `INTERNAL_SERVICE_TOKEN`, PII-free) and a worker swipe screen in
  `apps/worker-app` (`swipe_jobs_screen.dart` + `ApiClient` feed/apply/skip). The
  worker session bearer token is now plumbed into the `ApiClient` (memory-only,
  never logged) — the capstone "swipe" flow gap is closed **in code** (device
  verification still pending).
- **Phase-2 surfaces remain OUT** (restated, not changed): Reach ranking/scoring,
  employer console/posting, unlock/contact, payments/payouts/boosts, real matching.
  Crosses the Phase-1/2 line narrowly + deliberately, human-gated (Accepted
  2026-06-15, Prakash).
- See [ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md).

## 2026-06-15 — LiteLLM → direct Gemini/Claude providers (ADR-0008)
- **Seam clarified, not moved.** The provider abstraction is the
  `LlmAdapter`/`AIRouter` boundary; behind it `app/ai/providers.py` dispatches to
  **direct** transports — `gemini_client.py` (REST/httpx, primary) and
  `anthropic_client.py` (anthropic SDK, fallback) — chained **Gemini → Claude
  Haiku → deterministic mock**. The never-wired LiteLLM adapter is retired;
  `app/llm.py` remains only as the named seam example.
- **No new event, table, or contract surface;** no runtime behaviour change. The
  pseudonymization gateway still runs fail-closed upstream of every call.
- **Env unified (TD28):** Node `packages/config` now uses `GEMINI_FLASH_API_KEY`
  (master) + optional `ANTHROPIC_API_KEY`; `LITELLM_API_KEY` kept as a deprecated alias.
- **Still open:** no cumulative spend cap (TD27/R6) — the ADR names the
  `cost_tracker`/`AIRouter.run` hook for it.
- See [ADR-0008](../decisions/0008-litellm-to-direct-providers.md).

## 2026-06-09 — Async extraction (BullMQ) + action-recording seam (ADR-0002)
- **New seam: a BullMQ/Redis queue.** `/profile/extract` is now async — it
  enqueues a `profile-extraction` job (returns `202` + `ai_job_id`); a
  `ProfileExtractionProcessor` (in-process for Phase 1) does the AI work and
  emits `profile.extraction_completed`/`failed`. Clients poll `GET /ai-jobs/:id`.
- **New contract surface: action recording.** `POST /actions` + `/actions/batch`
  append a generic, extensible `action.recorded` event (controlled `action_type`
  as *data*) to the existing `events` spine — the behavioural stream for the
  future Learn layer. No new table.
- **Event count: 20 → 22** (`profile.extraction_failed`, `action.recorded`); new
  event domain `action`.
- **New external dependency on the extraction path:** Redis (already in stack).
- See [ADR-0002](../decisions/0002-async-extraction-and-action-recording.md).

## 2026-06-09 — Ops read-path + apps wired to live API
- API gained read-only ops endpoints (workers, events, ai-jobs).
- Next.js ops console wired to the live API (read-only).
- Flutter worker-app `ApiClient` replaced mock with real HTTP + typed models.
- Phase-1 e2e flow test added.
- *No new seams* — this fills in the existing event-first / repository-service
  architecture. Schema frozen for the (future) LLM layer: embeddings,
  model_training, storage tiers.

## 2026-06-08 — Architecture frozen for Phase 1 (ADR-0001)
Established the load-bearing shape the rest of the system hangs off:
- **Event-first.** `events` table is the spine + audit log; every important
  endpoint emits a validated event ([`@badabhai/event-schema`](../../packages/event-schema/), 22 events as of ADR-0002).
- **AI privacy boundary in the FastAPI service.** Pseudonymization runs before any
  LLM call and **fails closed**; PII never crosses to an LLM.
- **Repository/service separation** in the NestJS API over Drizzle; DI throughout.
- **Shared typed packages:** event-schema, db, config, types, validators,
  taxonomy, ai-contracts; reach-engine intentionally a placeholder.
- **Data shape:** 10 tables; PII (phone, full name) only in `workers`; events /
  ai_jobs / audit_logs carry ids/hashes only.

## Current component map (snapshot)
```
Worker (Flutter) ──────┐
Ops (Next.js)   ───────┤
Payer/Agency (payer-web)┤      ┌─ PayerAuthGuard (tenant: which payer)
                       ├─▶ NestJS API ─┤─ PayerRoleGuard (vertical: role='agent', ADR-0022)
                       │     │ HTTP     └─ assertPayerOwns (horizontal: own rows only)
                       │     │ (no raw PII)   · agency module (payer/agency/*) over jobs.payer_id
                       │     │                · reuses /payer/reach applicant feed
                       │     ▼──emit──▶ events table (incl. job.* / agency_invite.*, PII-free)
                       │     ▼
                 FastAPI AI: pseudonymize → mock/LLM ──(gated)──▶ Gemini→Claude (direct, ADR-0008)
                       │     ▼
                 Supabase Postgres (Drizzle) · agency_invites (faceless, FORCE-RLS)
```

> Keep the [overview](../architecture/overview.md) as the current truth; keep this
> file as the trail of how it changed. Link an ADR for any entry that has one.
