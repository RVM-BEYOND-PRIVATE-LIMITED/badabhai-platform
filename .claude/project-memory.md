# BadaBhai — Project Memory

> Rebuilt 2026-07-14 from a full repo re-audit (schema, ADRs, registers, git, tracker).
> Pairs with **CLAUDE.md** (invariants) and **team-memory.md** (ownership + active work).
> Live detail: ADRs in `docs/decisions/` (0001–0031), registers in `docs/registers/`,
> daily execution state in `docs/tracker/` (PROJECT_STATUS, BLOCKERS, DECISION_LOG, …).

# Project Overview

- AI "placement-team" for blue/grey-collar India; launch vertical = CNC/VMC manufacturing (15 trades built). Hospitality vertical: PRD **CEO-signed 2026-06-18**, all 9 `hosp_*` trades' resume + interview-kit content drafted in code — **not live pending per-trade RVM ratification PASS**. Faceless data-exchange: workers stay anonymous until a payer **pays to unlock** (₹40 flat, CEO-locked). North star = weekly PAID unlocks. Workers are free.
- **Phase 1 (worker profiling + resume) is the locked core; Phase-2 alpha-gate streams have landed additively behind launch gates** — swipe-to-apply, Reach feed, job postings, monetization/pricing, contact unlock, payer/agency portal, WhatsApp funnel (mock), PACE, admin portal, worker PIN auth, org tenancy, skills taxonomy. Real-money / real-provider / production-legal portions remain deferred (CLAUDE.md §8).
- **Status 2026-07-14: alpha NO-GO.** Sole capstone blocker = **B1 real-handset run against staging** (emulator evidence from PR #190 does not count). **P0: staging API not deployed — past the 2026-07-04 deadline** (owner Prakash; runbook `docs/ops/staging-service-deploy-runbook.md`). Alpha target 2026-08-15, soft launch Sep.

# Architecture

- **Event-first:** every important endpoint emits a `createEvent`-built, registry-validated event into append-only `events`. **100 event names across 28 domains, all v1.**
- **Services:** NestJS API (`apps/api`, **32 module dirs**) ↔ FastAPI AI service (`apps/ai-service`) ↔ single Supabase Postgres via Drizzle. Frontends: `apps/payer-web` (external payer+agency portal), `apps/web` (internal ops console), `apps/worker-app` (Flutter, 4 tabs: Jobs/Resume/Profile/Alerts).
- **AI privacy boundary:** `pseudonymize.py` before every LLM call, fail-closed. Direct Gemini (primary) + Claude Haiku (fallback) behind `LlmAdapter`/`AIRouter` (ADR-0008). Recent cost work: prompt-cache (COST-2), O(n) stateless chat turns (COST-3), templated questions (COST-4); mentor persona (AI-PERSONA-1/2).
- **Async:** BullMQ on Redis (extraction, transcription, deletion sweeps); clients poll `ai_jobs`.
- **Layering:** controller → service (emits events) → repository (Drizzle) + Zod dto + module. 9 guards: WorkerAuthGuard, ConsentGuard, ConsentNotRevokedGuard, PayerAuthGuard, PayerRoleGuard, PayerOrgRoleGuard, AdminAuthGuard, AdminRolesGuard, InternalServiceGuard.
- **Deterministic ranking:** `packages/reach-engine` (RANK core — scoring/ranking, ADR-0006/0011/0015); LLMs never rank. `packages/reach-learn` = **offline-only** calibration (ADR-0017), no live influence.

# Tech Stack

- pnpm 11 + Turborepo · NestJS (TS strict) · FastAPI · Next.js ×2 (payer-web external, web ops) · Flutter (go_router shell, ADR-0023; Flutter 3.35.7 vs older CI pin = TD61).
- **DB: ONE Supabase Postgres project (`Badabhai-DB`, ap-south-1) — the `main` DB is the only database. No localhost/dev/staging DB.** Drizzle authors the schema; **38 migrations** (0000–0037). CI/e2e use a throwaway per-run Postgres container, never the real DB.
- Redis + BullMQ (live). Vertex `text-multilingual-embedding-002` (768-dim) for profiling embeddings + skill aliases. Sarvam STT (mock default, ADR-0029 voice-at-rest Proposed). ZeptoMail (sandbox gate) for member invites. Langfuse placeholder.
- **Packages (10):** event-schema, db, config, types, validators, taxonomy, ai-contracts (Zod↔Pydantic mirror), **pricing (BUILT: fail-closed `resolvePrice`, ADR-0013)**, **reach-engine (BUILT)**, **reach-learn (BUILT, offline)**.
- **CI (6 workflows):** ci.yml (lint/typecheck/test/build + ruff/pytest + full-chain e2e on ephemeral pgvector Postgres), security-scan.yml, supabase-checks.yml, worker-app.yml (Flutter, blocking), staging-cd.yml + staging-demand-verify.yml (both `workflow_dispatch`). Dependabot enabled (CI-1, #218).

# Domain Models (39 tables — source of truth `packages/db/src/schema.ts`)

- **Worker identity/auth (4):** `workers` (PII root: phone AES-256-GCM + HMAC hash, full_name, deletion_scheduled_at pending ADR-0031), `worker_consents` (append-only DPDP), `worker_devices` (device_hash HMAC, push_token — ADR-0026), `worker_credentials` (scrypt PIN + lockout throttle, 1/worker).
- **Payer tenancy (3, ADR-0019/0022/0027):** `payers` (role employer|agent; email/phone/org **encrypted**), `payer_orgs` (tenant root), `payer_members` (invite→accept→remove; token hashed).
- **Chat/voice (3):** `chat_sessions` (conversation_state JSONB + archive storage path), `chat_messages`, `voice_notes` (transcripts = PII-class, never in events/LLM).
- **Profiling (5, ADR-0005):** `worker_profiles` (ai_job_id unique = idempotent extraction; embedding vector(768) HNSW), `profiles`/`questions`/`profile_questions`/`worker_answers` (1 per worker+question; free text pseudonymized pre-persist).
- **Resume (1):** `generated_resumes` (v1 idempotent per profile; pdf_storage_key; render_status).
- **Spine (3):** `events` (idempotency_key), `ai_jobs` (+ model/tokens/cost_inr), `audit_logs` — refs only.
- **Jobs (3):** `job_postings` (ops+payer, vacancy **band**), `jobs` (faceless feed jobs, banded pay/exp), `applications` (apply/skip unique per worker+job). Two job-shaped entities is known debt (TD37).
- **Unlock/credits (4, ADR-0010):** `unlocks` (worker_id SET NULL for DSAR), `payer_credits`, `credit_ledger` (append-only), `unlock_routing` (relay handle, never phone).
- **Pricing/monetization (5, ADR-0013/0016):** `pricing_catalog` (1 active JSONB row), `posting_plans`, `posting_boosts`, `resume_disclosures`, `payer_capacity` (enforcement INERT).
- **Invites/PACE (3, ADR-0020/0021/0022):** `invites`, `agency_invites`, `pace_states`.
- **Admin (2, ADR-0025):** `admin_users` (encrypted email, roles, MFA flag), `worker_flags` (code-only reason).
- **Skills taxonomy (3, ADR-0030 "TAX"):** `skill` (immutable text PK), `skill_alias` (embedding + HNSW), `unresolved_phrase` (pseudonymized aggregate, no worker_id).
- **PII map:** raw worker PII **only** in `workers`; encrypted B2B/admin PII in payers/payer_orgs/payer_members/admin_users; PII-adjacent: transcripts, chat bodies, worker_answers.answer_text, push tokens. RLS ENABLE+FORCE on **all 39 tables** (deny-all posture, no policies yet); backend connects with service role/BYPASSRLS (Q5/Q11 open).

# Business Rules (recurring)

- Consent is a hard gate; **disclosure (`employer_sharing`) consent is separate from profiling consent** (ADR-0010). Consent append-only; revoke via `revoked_at`.
- **§2 ruling (2026-07-14): a worker MAY decrypt-and-read their OWN full_name into their own session** (`GET /workers/me/resume-fields`); name still never reaches an LLM — don't re-escalate.
- Resume full_name injected server-side at render, never via LLM. Masking is **payer-only**; workers see their own data.
- **Money never ranks.** RANK weights are **CEO-locked (2026-06-19): Trade 35 / Location 20 / Skills 15 / Experience 15 / Salary 10 / Availability 5** — code must be reconciled TO these (add Skills, drop Activity); the older 06-12 "implemented weights authoritative" row is superseded. Ship flat, no demographics.
- Unlock price ₹40 flat; posting free-through-launch (verification-gated); capacity enforcement INERT by default.
- Extraction idempotent per ai_job_id; events idempotent per idempotency_key; voice ≤120s, retention indefinite (TD58, ADR-0029 pending); `is_required` = interview readiness only, never blocks matching.
- **Dead decisions (never rebuild):** Employer entity, 100-pt score, RVM-as-ranking, hire/no-show signals, BGE-M3 self-host, employer-specific prep, price ranges (→₹40), mobile-only surface.

# Event System

- `domain.action` naming; envelope: event_id/name/version, occurred_at, actor{}, subject{}, source, correlation_id, causation_id, payload, metadata. Payloads = ids/hashes/enums only.
- **100 events, 28 domains** (top: worker 16, ai 9, job_posting 7, admin 6, resume 5, profile 5, payer 5). All version 1; incompatible change ⇒ version bump, never mutate.
- `createEvent`/`validateEvent` (registry-driven, two-stage Zod). ADR-0031 will add `worker.deletion_scheduled/cancelled` (→102) when accepted.

# Security & Privacy Rules

- CLAUDE.md §2 invariants govern. PII set: phone, full name, address, employer names, ID tokens — never in LLM input/events/ai_jobs/audit_logs/logs.
- **Launch gates — 11 boolean env vars, ALL default false:** AI_ENABLE_REAL_CALLS, PAYMENTS_ENABLE_REAL, MESSAGING_ENABLE_REAL, MEMBER_INVITES_ENABLE_REAL, RESUME_RENDER_ENABLED, AUTH_ROLLING_TIERS_ENABLED, ADMIN_PII_REVEAL_ENABLED, ZEPTOMAIL_SANDBOX_MODE, CAPACITY_ENFORCEMENT_ENABLED, PACE_ENABLED, PACE_ADJACENCY_ENABLED. Payments/messaging/invites **refuse to boot** if true without provider creds. Flips need human sign-off, staging first.
- Worker auth = ADR-0026 (OTP + device PIN, scrypt, lockout cycles; TD62 kPersistentAuth is HIGH debt). Payer auth = PayerAuthGuard + org roles (ADR-0027). Admin = ADR-0025 (roles + MFA flag). **Money routes (unlock/reveal, posting plan) still ride InternalServiceGuard + body payer_id — LC-1 open (TD33/TD50).**
- Top open risks: R1 RLS unfinalized, R3 mock providers, R4/R19 DPDP legal copy, R10 conversation-bucket erasure, R24 admin privilege, R25 PIN/session.

# Coding Conventions

- Zod DTO + `ZodValidationPipe`; global `AllExceptionsFilter` (`{statusCode,error,requestId,path,timestamp}`); RequestIdMiddleware threads request/correlation ids into events; never log PII.
- Vitest (unit + `tests/e2e` against ephemeral PG), Pytest, `flutter analyze && flutter test` (blocking). Gate: `pnpm lint && typecheck && test && build` + `ruff check . && pytest`.
- Repos = Drizzle only, PII-excluding projections; services emit events; controllers thin. AI contracts stay Zod↔Pydantic mirrored (recent parity PRs #191/#193).

# Current Workstreams (2026-07-14)

- **Worker Alerts/notifications feed merged 2026-07-14 (#221):** API `GET /workers/me/notifications` (faceless event projection) + Flutter Alerts tab; #216 liberal jobs feed merged earlier. Uncommitted on `feat/worker-feed-liberal-no-location`: **ADR-0031 draft** (7-day deletion grace, PENDING Prakash/Akshit — reverses ADR-0026 D1/D2/D4; build §7-gated) + interview-kit test edits.
- **No open PRs** (gh-verified 2026-07-14 afternoon); **#222 FORK-B-1** request-path DB skill store (ADR-0030) merged 2026-07-14.
- **Recently shipped (#182–#222):** payer org tenancy B5.x, TAX-0..4 skills taxonomy + fork-B embed runner + FORK-B-1, COST-2/3/4, AI-PERSONA-1/2, worker-app backend wiring + Flutter 3.35.7 (Rishi), TD54 self-serve reads, resume name-edit + PDF-409 UX, TD25 trust-proxy, voice unblock (mock STT), CI-1 + Dependabot, Alerts feed (#221).
- **Blockers:** P0 staging deploy (overdue 07-04) → B1 capstone (needs PDF download working on staging, `RESUME_RENDER_ENABLED=true`); P1 payer-web FE wiring (FE-1..7), LC-1 money-route auth.
- **Pending decisions:** ADR-0031 (deletion grace), ADR-0005/0028/0029 Proposed; Q5/Q11 RLS identity; Q13 PACE adjacency (CEO); hospitality per-trade RVM ratification.
- Key dates: DPAs ≤07-07 (check status), alpha 2026-08-15, soft launch Sep 2026.

# Developer Notes (token-savers)

- Windows: `corepack pnpm` (pnpm not on PATH); `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`; build via `corepack pnpm --filter "@badabhai/<pkg>..." run build`; clear `*.tsbuildinfo` before API builds; e2e Postgres on **5433** (host PG owns 5432).
- **DB connect:** Session pooler `aws-1-ap-south-1.pooler.supabase.com:5432` + `?sslmode=require` (direct host IPv6-only); `DATABASE_URL` in root `.env` — load into shell before `pnpm db:migrate`. Never `supabase db push` (Drizzle owns migrations). **Check the latest migration number (0037) before `db:generate` — never collide.**
- `docs/tracker/` = daily execution state; `docs/registers/` = project memory; update in the same PR. Escalate per CLAUDE.md §7 (invariants, stack, destructive migrations, real keys/spend, production data).
