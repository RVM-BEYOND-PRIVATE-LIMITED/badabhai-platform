# Architecture Log

A chronological record of BadaBhai's architectural **state and changes** — the
"how did we get here" companion to the always-current
[architecture overview](../architecture/overview.md). Append an entry whenever the
shape of the system changes (new component, new seam, new contract surface, a
boundary moved).

---

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
Worker (Flutter) ─┐
                  ├─▶ NestJS API ──emit──▶ events table
Ops (Next.js)   ─┘      │ HTTP (no raw PII)
                        ▼
                 FastAPI AI: pseudonymize → mock/LLM ──(gated)──▶ Gemini→Claude (direct, ADR-0008)
                        ▼
                 Supabase Postgres (Drizzle)
```

> Keep the [overview](../architecture/overview.md) as the current truth; keep this
> file as the trail of how it changed. Link an ADR for any entry that has one.
