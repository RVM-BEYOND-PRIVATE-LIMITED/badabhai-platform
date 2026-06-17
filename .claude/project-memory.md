# BadaBhai — Project Memory

> Stable, high-value knowledge for fast session onboarding. Pairs with **CLAUDE.md**
> (the operating contract + invariants) and **team-memory.md** (ownership + active work).
> Trust this file; verify a fact only if code/docs contradict it. Source of truth for
> live detail = `docs/decisions/` (ADRs) and `docs/registers/`.

# Project Overview
- AI "placement-team" product for blue/grey-collar India; launches with industrial manufacturing (CNC/VMC) roles. Turns workers into live, profiled, contactable candidates via a **chat-first worker app**.
- **Business domains:** worker profiling · consent (DPDP) · chat/voice intake · AI profile extraction · resume generation · interview kit · events/audit spine · ops job postings + alpha swipe-to-apply (Phase‑2 leaning). Deferred: reach/matching, contact unlock, payments.
- **Phase: Phase 1 — Worker Profiling + Profile Generation (locked).** Exit criteria: worker logs in (mock OTP) → consent → chat → extracted + confirmed profile → generated resume; every step emits a validated event; no PII reaches an LLM; ops have read-only views.

# Architecture
- **Event-first:** every important state change emits a `createEvent`-built, schema-validated event into the append-only `events` table (the audit spine). No important change without an event.
- **Three services:** NestJS **API** (`apps/api`) ↔ Python FastAPI **AI service** (`apps/ai-service`) ↔ **Supabase Postgres** via Drizzle (`packages/db`). Next.js ops console and Flutter worker app are API clients.
- **AI privacy boundary:** API sends only pseudonymized/opaque data to the AI service; `pseudonymize.py` runs before every LLM call and **fails closed**.
- **Async AI work:** extraction/transcription run as **BullMQ** jobs (Redis); endpoints return a job id; clients poll `GET /ai-jobs/:id`.
- **Layering (every API module):** controller (HTTP only) → service (logic, emits events) → repository (Drizzle) + dto (Zod) + module (DI).
- **Data flow:** worker app → API (validate DTO → persist → emit event); AI path = enqueue job → AI service (pseudonymize → optional LLM → typed contract) → API persists result + emits completion event → ops console reads.

# Tech Stack
- Monorepo: **pnpm + Turborepo**. API: **NestJS** (TS strict). AI service: **FastAPI**. Ops console: **Next.js**. Worker app: **Flutter** (Android-first).
- DB: **Supabase Postgres + Drizzle** (16 tables; **pgvector** 768-dim embeddings). Queue/cache: **Redis + BullMQ**.
- AI routing: **direct Gemini (primary) + Claude Haiku (fallback)** behind `LlmAdapter`/`AIRouter` (ADR-0008; no LiteLLM proxy). Real calls gated by `AI_ENABLE_REAL_CALLS` (default off).
- External: Sarvam STT (gated), Langfuse (observability placeholder), Vertex embeddings.
- Shared packages: `event-schema`, `db`, `config`, `types`, `validators`, `taxonomy`, `ai-contracts`. `reach-engine` is a placeholder (Phase 1).

# Domain Models
- **Worker identity & consent:** `workers` (the *only* table with raw PII — phone/name, encrypted/hashed) → `worker_consents` (append-only DPDP records; revoke via `revoked_at`, never delete).
- **Chat & voice:** `chat_sessions` (`conversation_state` JSONB, no PII) → `chat_messages` (worker/system). `voice_notes` (storage path, ≤120s, transcript is PII-equivalent, `retain_indefinitely`).
- **Profiling:** `worker_profiles` (canonical profile; status `draft→extracting→extracted→confirmed`; `embedding` vector(768); `ai_job_id` unique). Questionnaire: `profiles` (per trade) ↔ `questions` (reusable catalog) via `profile_questions`; `worker_answers` (one per worker+question, upsert; free text pseudonymized before persist).
- **AI & resume:** `ai_jobs` (async tracker + cost metadata; refs only, no FK). `generated_resumes` (one per profile; render `pending/rendered/failed`; v1 idempotent).
- **Events & audit:** `events` (insert-only spine; `idempotency_key` dedup). `audit_logs` (who/what; no raw PII).
- **Jobs (alpha / Phase-2):** `job_postings` (ops vacancy register, vacancy-banded, zero employer PII), `jobs` (seeded alpha trades), `applications` (apply/skip, idempotent per worker+job).

# Business Rules (the ones that recur in implementation)
- **Consent gate:** no profiling/AI/disclosure before `consent.accepted` (fail-closed). Consent append-only. Disclosure consent is *separate* from profiling consent (ADR-0010).
- **No raw PII** in LLM input, events, payloads, `ai_jobs`, `audit_logs`, or logs — opaque ids / `*_hash` only. Raw PII lives only in `workers`.
- **Pseudonymization runs before every LLM call and fails closed.** LLMs assist, never decide (no rank/score/reject).
- Profile lifecycle is **async** (BullMQ); extraction **idempotent per `ai_job_id`**; triggers when `conversation_state.extraction_ready` flips (emits `profile.extraction_ready`).
- Resume **v1 idempotent per `profile_id`**; `full_name` injected **server-side at render**, never via the LLM.
- Voice notes ≤ **120s**; `retain_indefinitely` in Phase 1.
- `is_required` on questions drives **interview readiness only** — never blocks matching.
- Event emission is at-least-once; `idempotency_key` makes it retry-safe (NULL keys never collide).
- **Backward compat:** never mutate a shipped event payload schema or drop an in-use column — version it.

# Event System
- **Naming:** `domain.action` (snake_case action), e.g. `worker.created`, `profile.extraction_completed`, `ai.llm_call_failed`.
- **Domains/prefixes:** worker · consent · chat · voice_note · profile · resume · interview_kit · action · ai · job_posting · feed (P2) · application (P2).
- **Envelope fields:** `event_id, event_name, event_version, occurred_at, actor{type,id,…}, subject{type,id}, source, correlation_id, causation_id, payload, metadata`. Payloads carry ids/hashes/enums only.
- **Build/validate:** `createEvent` / `validateEvent` / `assertValidEvent` — Zod, registry-driven, two-stage (envelope, then payload keyed by `event_name`). Throws `EventValidationException` on invalid.
- **Versioning:** one current version per `event_name` in the registry; incompatible change → bump + keep old schema (full multi-version handling deferred).
- **Storage:** append-only `events` table; rows threaded with `correlation_id` + `request_id`.

# Security & Privacy Rules
- **PII set:** phone, full name, address, employer names, ID-doc tokens. Never in LLM input / events / `ai_jobs` / `audit_logs` / logs. Only in `workers`, encrypted at rest (ADR-0004).
- **DPDP consent is a hard gate** (ADR-0010); `model_training` lawful basis captured from day one.
- Pseudonymization fail-closed (`apps/ai-service/app/pseudonymize.py`) — never add an LLM path that bypasses it.
- Real LLM/OTP/STT calls are flag-gated and **off by default**; staging first.
- **Access control:** backend uses the Supabase **service role / BYPASSRLS** today. RLS hardened on spine tables (migration 0009) but **not platform-wide**; per-worker isolation deferred (TD4).
- AI I/O contracts mirrored **Zod (`packages/ai-contracts`) ↔ Pydantic (`apps/ai-service/app/contracts.py`)** — keep in parity.

# Coding Conventions
- **Validation:** Zod DTO (`*.dto.ts`) + `@Body(new ZodValidationPipe(Schema))`; shared schemas in `@badabhai/validators`.
- **Error handling:** global `AllExceptionsFilter` → `{statusCode, error, requestId, path, timestamp}`. `RequestIdMiddleware` sets `requestId` + `correlationId` (honors `x-request-id`/`x-correlation-id`), surfaced via `@Ctx()` and threaded into events. Structured logger; never log raw PII.
- **Testing:** Vitest (TS unit + e2e under `tests/e2e/*.e2e.test.ts`), Pytest (AI service), `flutter analyze && flutter test` (blocking since 2026-06-15). CI gate: `pnpm lint && typecheck && test && build`; `ruff check . && pytest`.
- **Repository rule:** data access only in `*.repository.ts` (Drizzle, PII-excluding projections); business logic + event emission only in services; controllers stay thin.

# Current Workstreams
- **Active branch:** `feat/job-posting-alpha-gate` — ADR-0012 ops job postings (vacancy-banded, stored-only).
- **Recently shipped:** async extraction/transcription (BullMQ), resume PDF render (WeasyPrint, ADR-0007), Sarvam STT gated (PR #32), direct providers (ADR-0008), event + profile idempotency, RLS hardening (mig 0009), `full_name` encryption, AI spend caps, Flutter CI blocking.
- **Open tech debt (high-value):** TD2 mock OTP · TD3 heuristic pseudonymization · TD4 RLS not platform-wide · TD12 in-process extraction worker · TD15 untyped/unauthz `GET /ai-jobs/:id` · TD29 worker-app alpha flows incomplete · TD30 CORS open · TD17/TD31 duplicated question bank/trade enums · TD34 job-posting deferrals.
- **Open questions:** real OTP provider (Q1) · unlock pricing (Q2) · Sarvam contract (Q4) · RLS model (Q5) · DPDP data residency (Q6) · scale targets (Q7).
- **Decisions of record:** ADRs **0001–0012** in `docs/decisions/` (key: 0004 PII/RLS · 0005 metadata profiling · 0007 resume render · 0008 direct providers · 0009 alpha swipe · 0010 contact unlock · 0012 job postings).

# Developer Notes (token-savers)
- Read **CLAUDE.md**, this file, and **team-memory.md** first — don't rediscover architecture/ownership/rules.
- **Windows/pnpm:** pnpm not on PATH → use `corepack pnpm`; prefix builds with `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`; turbo can't find pnpm → build via `corepack pnpm --filter "@badabhai/<pkg>..." run build`.
- **DB:** remote Supabase = **Session pooler host `:5432` + `?sslmode=require`** (direct host is IPv6-only); `DATABASE_URL` in root `.env`; load it before `pnpm db:migrate`. **Drizzle is the schema source of truth — do not `supabase db push`.**
- **API:** no global prefix, port **3001**, CORS open, **no auth/JWT in Phase 1** (mock OTP returns a `worker_id`, not a token).
- `docs/registers/` is project memory — update the relevant register in the same PR as the change.
- **Escalate (stop & ask)** on: changing a §2 CLAUDE.md invariant, a stack change, a destructive migration, real provider keys/spend, or anything touching production data.
