# BADABHAI — COMPLETE CODEBASE INTELLIGENCE & CURRENT STATE REPORT

**Classification:** Internal Engineering Reference
**Date:** September 1, 2026
**Prepared by:** Codebase Forensic Analysis
**Scope:** Every repository, every file, every schema, every API, every AI call, every queue, every feature flag, every dormant module, every risk

---

# PART I — SYSTEM IDENTITY

## 1.1 What Badabhai Is

Badabhai is an **AI-first hiring platform** built for blue-collar, grey-collar, industrial manufacturing, construction, and skilled trade workers in India. The platform's primary objective is to digitize workers through AI-assisted profiling, generate high-quality professional profiles and resumes, connect workers with the most relevant employers, and improve hiring quality using deterministic engineering and AI assistance.

The platform serves three user classes:
- **Workers** — Blue/grey-collar workers who may not have resumes. They interact via a chat-first mobile app (Hinglish voice/text).
- **Employers/Payers** — Companies and agencies who post jobs, view ranked candidate lists, and pay to unlock worker contacts.
- **Admins** — Internal platform operators who manage the system, review skills, and monitor events.

## 1.2 Engineering Philosophy

The codebase enforces these non-negotiable principles:
- **Event First:** Every important business action emits a validated event.
- **Privacy First:** Raw PII never crosses AI, log, event, or audit boundaries.
- **AI Never Owns Business Decisions:** LLMs extract, summarize, generate, explain, classify — but never rank, reject, or decide.
- **Fail Closed:** Validation, privacy, authentication, or AI safety failures halt processing.
- **Backward Compatibility:** Never break APIs, mutate event schemas, or drop production columns.

---

# PART II — REPOSITORY INVENTORY

## 2.1 Monorepo Structure

The codebase is a **pnpm workspace monorepo** managed by Turborepo. Python (apps/ai-service) and Flutter (apps/worker-app, apps/payer-app) manage their own toolchains and are NOT part of the pnpm workspace.

**Root configuration files:**
- `package.json` — Root workspace, pnpm@11.5.2, Node>=20
- `pnpm-workspace.yaml` — Workspace member list, supply-chain policy, security overrides
- `turbo.json` — Build pipeline configuration
- `tsconfig.base.json` — Shared TypeScript config
- `eslint.config.mjs` — Shared ESLint config
- `.prettierrc.json` — Code formatting
- `.tool-versions` — Flutter 3.35.7-stable pinned
- `docker-compose.yml` — Local development stack
- `docker-compose.staging.yml` — Production overlay
- `docker-compose.e2e.yml` — E2E testing override

## 2.2 Applications (8 total)

| Application | Framework | Port | Target User | Package Manager |
|------------|-----------|------|-------------|-----------------|
| `apps/api` | NestJS 11 | 3001 | Backend (all clients) | pnpm |
| `apps/ai-service` | FastAPI (Python) | 8000 | AI processing | uv/pip |
| `apps/web` | Next.js 15.5 | 3000 | Internal ops | pnpm |
| `apps/payer-web` | Next.js 15.5 | 3002 | Employers/Agencies | pnpm |
| `apps/admin-web` | Next.js 15.5 | 3003 | Internal admins | pnpm |
| `apps/marketing-web` | Next.js 15.5 | 3004 | Public | pnpm |
| `apps/worker-app` | Flutter 3.35 | Android/iOS | Workers | Flutter/Dart |
| `apps/payer-app` | Flutter 3.35 | Android/iOS | Employers/Agencies | Flutter/Dart |

## 2.3 Packages (12 total)

| Package | Purpose | Dependencies | Key Exports |
|---------|---------|--------------|-------------|
| `packages/ai-contracts` | Zod schemas for AI boundaries | zod | `ProfilingTurnRequest`, `VoiceTranscriptionRequest`, `SkillCanonicalizationRequest` |
| `packages/config` | Typed env validation (server/public split) | zod | `ServerConfig`, `PublicConfig`, 150+ validated env fields |
| `packages/db` | Drizzle ORM schemas + migrations | drizzle-orm, pg | 72+ table definitions, migrations, seed scripts |
| `packages/event-schema` | Event envelope + validation | zod | `EventEnvelope`, `EventRegistry`, 14+ event payload types |
| `packages/match-engine` | V1 lexicographic ranking | none | `rankCandidates()`, `deriveRankKey()`, `resolveReachSet()` |
| `packages/pricing` | Config-driven pricing engine | zod | `resolvePrice()`, `DEFAULT_CATALOG`, `formatInr()` |
| `packages/profiling-lexicon` | Hinglish lexicon + normalizers | none | `normalizeOccupationText()`, `classifyUtterance()`, `parseExperienceYears()` |
| `packages/reach-engine` | Weighted scoring for recommendations | none | `computeReach()`, `scoreCandidate()`, `rankByScore()` |
| `packages/reach-learn` | Offline weight calibration | none | `calibrate()`, `shadowEvaluate()`, `widenNeverNarrow()` |
| `packages/taxonomy` | Occupation/skill/domain vocabulary | none | `Domain`, `Role`, `Skill`, `PROMOTABLE_SKILLS`, `matchSkill()` |
| `packages/types` | Shared domain enums | none | `WorkerStatus`, `ChatSessionStatus`, `LANGUAGE_CODES`, `CONSENT_PURPOSES` |
| `packages/validators` | Shared Zod schemas | zod, @badabhai/types | `e164PhoneSchema`, `otpDigitsSchema`, `looksLikePii()` |

## 2.4 Tests

| Layer | Test Files | Framework | Environment |
|-------|-----------|-----------|-------------|
| `apps/api` | 402 `.test.ts` | Vitest 3.x | node |
| `apps/ai-service` | 72 `.py` | pytest | Mock-only + egress guard |
| `apps/worker-app` | 185 `_test.dart` | flutter_test | Dart widget/bloc |
| `apps/payer-web` | 89 `.test.*` | Vitest 3.x | node (server-only stub) |
| `apps/admin-web` | 49 `.test.*` | Vitest 3.x | node (server-only stub) |
| `apps/web` | 7 `.test.ts` | Vitest 3.x | node |
| `apps/marketing-web` | 1 `.test.tsx` | Vitest 3.x | node |
| `packages/db` | 107 `.test.ts` | Vitest 3.x | In-process |
| `packages/match-engine` | 12 `.test.ts` | Vitest 3.x | Pure logic |
| `packages/reach-engine` | 3 `.test.ts` | Vitest 3.x | Pure logic |
| `packages/reach-learn` | 6 `.test.ts` | Vitest 3.x | Pure logic |
| `packages/taxonomy` | 6 `.test.ts` | Vitest 3.x | Pure logic |
| `packages/config` | 8 `.test.ts` | Vitest 3.x | Pure logic |
| `packages/validators` | 1 `.test.ts` | Vitest 3.x | Pure logic |
| `packages/pricing` | 2 `.test.ts` | Vitest 3.x | Pure logic |
| `packages/ai-contracts` | 1 `.test.ts` | Vitest 3.x | Pure logic |
| `tests/e2e/` | 13 `.e2e.test.ts` | Vitest 3.x | Live API + Postgres + Redis |
| `tests/contract/` | 0 (placeholder) | — | — |
| `tests/security/` | 0 (placeholder) | — | — |

**Estimated total: ~960+ test files**

---

# PART III — ARCHITECTURE

## 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Worker   │  │ Payer    │  │ Admin    │  │ Ops      │           │
│  │ App      │  │ App/Web  │  │ Web      │  │ Web      │           │
│  │ (Flutter)│  │ (Flutter/│  │(Next.js) │  │(Next.js) │           │
│  │          │  │ Next.js) │  │          │  │          │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │              │              │              │                 │
└───────┼──────────────┼──────────────┼──────────────┼────────────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        API LAYER (NestJS, port 3001)                 │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Guards: WorkerAuthGuard | PayerAuthGuard | AdminAuthGuard   │    │
│  │         | InternalServiceGuard | ConsentGuard               │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Controllers: 67 controllers, 200+ routes                    │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Services: ~75 services (business logic, event emission)     │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Repositories: ~55 repositories (DB access only)             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Processors: 12 BullMQ workers (background jobs)             │    │
│  └─────────────────────────────────────────────────────────────┘    │
└───────────┬──────────────────────────────────┬──────────────────────┘
            │                                  │
            ▼                                  ▼
┌───────────────────────┐        ┌───────────────────────────────────┐
│  AI SERVICE           │        │  INFRASTRUCTURE                    │
│  (FastAPI, port 8000) │        │                                    │
│                       │        │  ┌──────────┐  ┌──────────────┐  │
│  ┌─────────────────┐  │        │  │PostgreSQL│  │ Redis        │  │
│  │ AIRouter         │  │        │  │(Supabase)│  │ (queues,     │  │
│  │ (single entry)   │  │        │  │          │  │  buffers,    │  │
│  └────────┬────────┘  │        │  │ 72+ tables│  │  rate limits)│  │
│           │           │        │  └──────────┘  └──────────────┘  │
│  ┌────────▼────────┐  │        │                                    │
│  │ Providers:      │  │        │  ┌──────────────────────────────┐ │
│  │ Gemini (primary)│  │        │  │ Supabase Storage             │ │
│  │ Anthropic (fall)│  │        │  │ (resumes, photos, voice)     │ │
│  │ Sarvam (STT)    │  │        │  └──────────────────────────────┘ │
│  └─────────────────┘  │        │                                    │
│                       │        │  ┌──────────────────────────────┐ │
│  ┌─────────────────┐  │        │  │ External Services            │ │
│  │ Profiling       │  │        │  │ Fast2SMS (worker OTP)        │ │
│  │ Resume Gen      │  │        │  │ ZeptoMail (payer email)      │ │
│  │ Skill Embed     │  │        │  │ Razorpay (payments)          │ │
│  │ Voice/STT       │  │        │  │ FCM (push notifications)     │ │
│  └─────────────────┘  │        │  │ Langfuse (observability)     │ │
└───────────────────────┘        │  └──────────────────────────────┘ │
                                 └───────────────────────────────────┘
```

## 3.2 Module Import Tree (NestJS API)

```
AppModule
├── AppConfigModule              (config — Zod env validation)
├── CryptoModule                 (PII encryption/hashing)
├── DatabaseModule               (Drizzle ORM connection)
├── QueueModule                  (@Global — BullMQ root config)
├── EventsModule                 (@Global — event emission)
├── AiModule                     (@Global — AI service client, cost/trace recording)
├── WorkersModule                (worker CRUD, profile summary)
├── AuthModule                   (OTP, JWT, PIN, sessions, devices, account deletion)
├── ConsentModule                (DPDP consent management)
├── ChatModule                   (interview conversation, Redis buffer, transcript flush)
├── ProfilingModule              (deterministic interview engine, pack registry, LLM turns)
├── VoiceModule                  (voice notes, transcription)
├── SkillsModule                 (skill vocabulary, canonicalization)
├── OccupationModule              (occupation resolution)
├── ProfilesModule               (profile extraction, AI jobs, attributes)
├── ResumeModule                 (resume generation, PDF rendering, templates)
├── InterviewKitModule           (trade-specific interview prep materials)
├── ApplicationsModule           (worker job applications)
├── JobsModule                   (job search, detail)
├── JobPostingsModule            (job posting CRUD)
├── MatchModule                  (matching V1, reach, candidate ranking)
├── ReachModule                  (reach engine integration)
├── UnlocksModule                (contact unlock, credits, Razorpay)
├── PricingModule                (pricing catalog management)
├── PostingPlansModule           (posting plans, boosts, quotas)
├── PayersModule                 (payer account management)
├── PayerPortalModule            (payer self-serve portal, job posting chat)
├── AgencyModule                 (agency jobs, invites, payouts, KYC)
├── ReferralAttributionModule    (referral tracking, bonus evaluation)
├── MessagingModule              (WhatsApp invites, re-engagement)
├── PaceModule                   (supply-widening waves)
├── LearnModule                  (training label production)
├── FeedbackModule               (worker feedback)
├── ActionsModule                (behavioral action logging)
├── NotificationsModule          (worker alert feed)
├── PushModule                   (FCM push notifications)
├── EmailNotificationModule      (@Global — email provider)
├── RateLimitModule              (Redis-based rate limiting)
├── PdfModule                    (WeasyPrint HTML→PDF)
├── HealthModule                 (readiness probe)
└── AdminModule                  (admin auth, entities, events, finance, kill switch)
```

## 3.3 Runtime Architecture

### Process Communication Map

```
Worker App ──HTTP──▶ API ──HTTP──▶ AI Service
                          │
Payer Web ──HTTP──▶ API ──┤
                          │
Admin Web ──HTTP──▶ API ──┤
                          │
Ops Web ──HTTP──▶ API ────┘
                          │
                          ├──▶ PostgreSQL (Drizzle ORM)
                          ├──▶ Redis (BullMQ, rate limits, buffers)
                          ├──▶ Supabase Storage (files)
                          ├──▶ Fast2SMS (worker OTP)
                          ├──▶ ZeptoMail (payer email)
                          ├──▶ Razorpay (payments, webhooks)
                          └──▶ FCM (push)

AI Service ──▶ Gemini API (LLM)
           ──▶ Anthropic API (fallback LLM)
           ──▶ Sarvam API (STT/TTS/translate)
           ──▶ Langfuse (observability)
```

## 3.4 Deployment Architecture

### Local Development

```yaml
services:
  postgres: pgvector/pgvector:pg16 (port 5432)
  redis: redis:7-alpine (port 6379, AOF persistence)
  adminer: adminer:4 (port 8080)
  api: badabhai-api:latest (port 3001, profile-gated)
  ai-service: badabhai-ai-service:latest (port 8000, profile-gated)
  proxy: nginx:1.27-alpine (port 8088, reverse proxy harness)
  mailpit: axllent/mailpit (port 1025/8025, mail catcher)
```

### Production (AWS Lightsail)

- Docker Compose with staging overlay
- Immutable per-commit image tags (`sha-<short7>`)
- GitHub Actions CI/CD pipeline
- Health-gated deploys (every service checked before next starts)
- Loopback-only ports (except API 3001 and Payer Web 3333)
- Redis AOF persistence with canary test

### CI/CD Pipeline

12 jobs in the CI pipeline:
1. Path filtering + image build matrix
2. Shellcheck, pnpm lint/typecheck/test/build
3. Python pytest + ruff linting
4. Docker image build validation (PR-only)
5. E2E tests (real Postgres + Redis)
6. Flutter worker-app analyze/test
7. Flutter payer-app analyze/test
8. Build + publish release APKs
9. Semgrep SAST scanning
10. Dependency audit
11. CI aggregator gate (branch protection)
12. Docker image build + push to ghcr.io
13. SSH deploy to AWS Lightsail

---

# PART IV — DATABASE INVENTORY

## 4.1 Complete Table Map (72+ tables across 22 domains)

### Worker Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `workers` | Worker accounts | id, phone_e164_encrypted, phone_e164_hash, status, photo_key, full_name_encrypted, resume_prefs, deletion_scheduled_at | Active |
| `worker_profiles` | Extracted profiles (versioned) | id, worker_id, ai_job_id, trade_id, role_id, skills, machines, experience_years, salary_expected, city, state, region, availability, relocation, status | Active |
| `worker_attributes` | 319+ structured attribute rows | id, worker_id, profile_id, field_id, value_text, value_number, value_boolean, value_text_list, source_method, confidence, pack_id | Active |
| `worker_skills` | Projected skill-match rows | id, worker_id, skill_id, domain_id, months, confidence | Active |
| `worker_industry_tenure` | Projected tenure rows | id, worker_id, domain_id, months, confidence | Active |
| `worker_employment` | Work history entries | id, worker_id, employer_name_encrypted, role, domain_id, start_date, end_date, is_current | Active |
| `worker_transcript` | Worker quotes for resume | id, worker_id, session_id, message_id, text_pseudonymized, role_in_quote | Active |
| `worker_feedback` | Worker feedback | id, worker_id, category, message, build_info, screen_context | Active |
| `worker_feedback_attachments` | Feedback images | id, feedback_id, storage_path, content_type, size_bytes | Active |
| `worker_actions` | Behavioral action log | id, worker_id, action_type, action_context, screen_context | Active |
| `worker_consents` | DPDP consent records | id, worker_id, purpose, accepted, consent_version, ip_hash | Active |
| `worker_devices` | Device registrations | id, worker_id, device_fingerprint, push_token, platform, is_active | Active |
| `worker_push_claims` | Push delivery dedup | id, worker_id, source_event_id, device_id, claimed_at | Active |

### Chat/Profiling Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `chat_sessions` | Interview sessions | id, worker_id, status, channel, started_at, ended_at, last_activity_at, flush_status | Active |
| `chat_messages` | Conversation messages | id, session_id, direction, content_type, content_pseudonymized, worker_name_placeholder | Active |
| `pack_answers` | Deterministic interview answers | id, session_id, worker_id, pack_id, item_id, field_id, value_raw, value_normalized, evidence_span, confidence, method | Active |
| `voice_notes` | Voice note metadata | id, worker_id, session_id, storage_path, duration_seconds, language_code, transcript_text, transcript_status | Active |
| `worker_question_pack_transcript` | Voice profiling answer chain | id, worker_id, session_id, pack_id, item_id, audio_storage_path, transcript_text | Active |

### Profile/Resume Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `resumes` | Generated resume versions | id, worker_id, profile_id, version, template_id, status, render_status, storage_object_key, ai_job_id | Active |
| `resume_disclosures` | Employer-facing masked resumes | id, worker_id, payer_id, resume_id, disclosure_type, status | Active |

### Job/Application Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `job_postings` | Job listings | id, payer_id, title, domain_id, role_id, city, state, vacancy_band, status, verification_status, salary_min, salary_max, shift, benefits | Active |
| `applications` | Worker job applications | id, worker_id, job_posting_id, status, rank_snapshot, applied_at | Active |
| `job_reach` | Reach materialization | id, worker_id, job_posting_id, match_tier, score, rank_position, engine_version | Active |
| `job_reach_widen` | Reach widening grants | id, job_posting_id, trade_id, domain_id, area_km, expires_at, retracted_at | Active |
| `job_boosts` | Posting boost records | id, job_posting_id, boost_tier, starts_at, expires_at | Active |

### Payer Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `payers` | Employer/agency accounts | id, phone_e164_encrypted, email_encrypted, org_name_encrypted, role, status | Active |
| `payer_org_members` | Team membership | id, payer_id, org_role, invited_by, status | Active |
| `payer_org_invites` | Pending invites | id, org_payer_id, invite_code, email_encrypted, invited_by, expires_at | Active |
| `unlocks` | Contact unlock requests | id, payer_id, worker_id, status, granted_at, revealed_at, relay_handle | Active |
| `credits` | Credit ledger | id, payer_id, balance, total_earned, total_spent | Active |
| `credit_orders` | Payment orders | id, payer_id, razorpay_order_id, amount_inr, status, credits_granted | Active |

### Agency Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `agency_jobs` | Agency-created jobs | id, agency_payer_id, title, domain_id, city, status | Active |
| `agency_kyc` | Agency KYC | id, payer_id, pan_encrypted, bank_account_encrypted, status, reviewed_by | Active |
| `agency_earnings` | Commission tracking | id, payer_id, unlock_id, commission_inr, status | Active |
| `agency_payouts` | Payout requests | id, payer_id, amount_inr, status, requested_at, processed_at | Active |
| `referral_attributions` | Referral tracking | id, inviter_worker_id, invited_worker_id, invite_code, attributed_at | Active |
| `referral_bonuses` | Activation bonuses | id, inviter_worker_id, invited_worker_id, bonus_inr, status | Active |

### AI/Observability Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `ai_jobs` | Async AI job tracking | id, worker_id, type, status, provider, model, request_metadata, result_metadata, started_at, completed_at | Active |
| `ai_cost_records` | AI spend ledger | id, ai_job_id, worker_id, task_type, provider, model, input_tokens, output_tokens, cost_inr | Active |
| `ai_traces` | Encrypted AI call traces | id, ai_job_id, task_type, provider, model, prompt_encrypted, completion_encrypted, duration_ms | Active |
| `events` | Event audit trail | id, event_type, aggregate_id, version, payload, metadata, idempotency_key, created_at | Active |
| `admin_users` | Admin accounts | id, email, role, mfa_secret_encrypted, status | Active |
| `admin_roles` | Role definitions | id, name, capabilities | Active |

### Skill/Taxonomy Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `skill_taxonomy` | Canonical skill vocabulary | id, label, domain_id, industry, promotable, status | Active |
| `skill_aliases` | Skill alias mappings | id, skill_id, alias, locale, source | Active |
| `skill_alias_embeddings` | HNSW vector index | id, skill_alias_id, embedding vector(768) | Active |
| `skill_discovery` | Unresolved skill candidates | id, raw_label, worker_id, status, reviewed_by, decision, canonical_skill_id | Active |
| `domain_taxonomy` | Domain vocabulary | id, label, industry_id, nco_code, isco_code | Active |
| `domain_aliases` | Domain alias mappings | id, domain_id, alias, locale, source | Active |
| `domain_alias_embeddings` | HNSW vector index | id, domain_alias_id, embedding vector(768) | Active |
| `occupation_families` | Occupation classification | id, label, nco_code, isco_code | Active |

### Pricing Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `pricing_catalog` | Config-driven pricing versions | id, version, catalog_json, published_by, published_at, is_active | Active |

### PACE Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `pace_states` | Supply-widening state per job | id, job_posting_id, current_area_km, current_adjacent, wave_number, status | Active |
| `pace_waves` | Wave execution log | id, state_id, wave_number, action, supply_count, area_km, executed_at | Active |

### Referral Domain

| Table | Purpose | Key Columns | Status |
|-------|---------|-------------|--------|
| `referral_links` | Referral invite tracking | id, inviter_worker_id, invite_code, click_count, convert_count | Active |
| `learn_labels` | Training labels for reach-learn | id, impression_event_id, candidate_id, job_id, label, confidence, resolved_at | Active |

## 4.2 Key Relationships

```
Worker (1) ──▶ (N) WorkerProfile
WorkerProfile (1) ──▶ (N) WorkerAttribute
Worker (1) ──▶ (N) ChatSession
ChatSession (1) ──▶ (N) ChatMessage
ChatSession (1) ──▶ (N) PackAnswer
Worker (1) ──▶ (N) VoiceNote
Worker (1) ──▶ (N) Resume
Resume (1) ──▶ (N) ResumeVersion
Worker (1) ──▶ (N) Application
JobPosting (1) ──▶ (N) Application
Worker (1) ──▶ (N) JobReach
JobPosting (1) ──▶ (N) JobReach
Payer (1) ──▶ (N) JobPosting
Payer (1) ──▶ (N) Unlock
Payer (1) ──▶ (N) CreditOrder
Worker (1) ──▶ (N) ReferralAttribution
Worker (1) ──▶ (N) ReferralBonus
Worker (1) ──▶ (N) AiJob
AiJob (1) ──▶ (N) AiCostRecord
AiJob (1) ──▶ (N) AiTrace
SkillTaxonomy (1) ──▶ (N) SkillAlias
DomainTaxonomy (1) ──▶ (N) DomainAlias
```

---

# PART V — API INVENTORY (COMPLETE)

## 5.1 Worker Auth APIs

| Method | Route | Purpose | Auth | Rate Limit | Idempotent |
|--------|-------|---------|------|------------|------------|
| `POST /auth/otp/request` | Send SMS login code | None | Per-IP hourly, per-phone hourly, global daily | Yes (Idempotency-Key) |
| `POST /auth/otp/verify` | Verify OTP, mint JWT | None | Per-device hourly | Yes (Idempotency-Key) |
| `POST /auth/test-login` | QA: mint session for test phone | TestLoginGuard | Per-phone daily | No |
| `GET /auth/me` | Current worker identity | WorkerAuthGuard | No | No |
| `POST /auth/refresh` | Refresh rolling JWT | WorkerAuthGuard, ConsentNotRevokedGuard | No | No |
| `POST /auth/logout` | Revoke current session | WorkerAuthGuard | No | No |
| `POST /auth/logout-all` | Revoke ALL sessions | WorkerAuthGuard | No | No |
| `POST /auth/token/refresh` | Silent refresh token rotation | None (refresh token is credential) | No | Yes (Idempotency-Key) |
| `GET /auth/session` | Tier + expiry introspection | WorkerAuthGuard | No | No |
| `POST /auth/account/delete/request` | Step-up OTP for DPDP deletion | WorkerAuthGuard | No | No |
| `POST /auth/account/delete/confirm` | Confirm deletion OTP | WorkerAuthGuard | No | No |
| `POST /auth/account/delete/cancel` | Cancel pending deletion | WorkerAuthGuard | No | No |
| `POST /auth/account/delete/immediate` | QA: immediate hard-delete | WorkerAuthGuard, flag-gated | No | No |

## 5.2 Worker PIN APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /auth/pin/set` | Set/replace worker PIN | WorkerAuthGuard |
| `POST /auth/pin/verify` | Verify device-bound PIN | None (refresh token is credential) |
| `POST /auth/pin/reset/request` | Send OTP for PIN reset | None |
| `POST /auth/pin/reset/confirm` | Verify OTP + set new PIN | None |

## 5.3 Worker Device APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /auth/devices` | List worker's active devices | WorkerAuthGuard |
| `PATCH /auth/devices/me/push-token` | Record FCM token | WorkerAuthGuard |
| `DELETE /auth/devices/:id` | Revoke one device | WorkerAuthGuard |

## 5.4 Consent APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /consent/accept` | Accept DPDP consent | WorkerAuthGuard |
| `POST /consent/withdraw` | Withdraw consent | WorkerAuthGuard |

## 5.5 Worker Profile APIs

| Method | Route | Purpose | Auth | AI |
|--------|-------|---------|------|-----|
| `GET /workers/me/profile-summary` | Profile card view | WorkerAuthGuard, ConsentGuard | No |
| `GET /workers/me/resume-fields` | Editable resume fields | WorkerAuthGuard, ConsentGuard | No |
| `GET /workers/me/photo-url` | Signed URL for photo | WorkerAuthGuard, ConsentGuard | No |
| `GET /workers/me/profile` | Latest profile + resume | WorkerAuthGuard, ConsentGuard | No |
| `GET /workers/:id/profile` | Ops view of worker+profile | InternalServiceGuard | No |
| `PUT /workers/:id/name` | Ops-set worker name | InternalServiceGuard | No |
| `PATCH /workers/me/name` | Worker self-set name | WorkerAuthGuard, ConsentGuard | No |
| `PATCH /workers/me/resume-prefs` | Update show-photo/night-shift | WorkerAuthGuard, ConsentGuard | No |
| `POST /workers/me/photo/upload-url` | Mint signed upload URL | WorkerAuthGuard, ConsentGuard | No |
| `POST /workers/me/photo` | Confirm photo upload | WorkerAuthGuard, ConsentGuard | No |
| `DELETE /workers/me/photo` | Remove profile photo | WorkerAuthGuard, ConsentGuard | No |

## 5.6 Work Preferences APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /workers/me/work-preferences/options` | Closed-set option chips, plus the `cities` catalogue | WorkerAuthGuard, ConsentGuard |
| `PUT /workers/me/work-preferences` | Record closed-set answers | WorkerAuthGuard, ConsentGuard |

The options response carries five keys: the four slug→label dictionaries (`languages`,
`documents_ready`, `job_type`, `shift`) and `cities` — a list of `{ value, aliases }` derived from
the shared gazetteer that `preferred_cities` validates against (#1406). `value` is both the chip
label and the string the client must submit; `aliases` are lowercase search keys only ("dilli" →
Delhi), never displayed. Served whole rather than behind a `?q=` route because the gazetteer is 34
values and ~1.2 KB, so the client filters it in memory — the pattern `SEARCHABLE_OPTION_THRESHOLD`
already sets for every other long option list.

## 5.7 Employment APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `PUT /workers/me/employment` | Replace work history (max 4) | WorkerAuthGuard, ConsentGuard |

## 5.8 Chat/Interview APIs

| Method | Route | Purpose | Auth | AI |
|--------|-------|---------|------|-----|
| `POST /chat/session` | Start interview session | WorkerAuthGuard, ConsentGuard | Yes (LLM) |
| `POST /chat/message` | Send interview message | WorkerAuthGuard, ConsentGuard | Yes (LLM) |
| `GET /chat/sessions/:sessionId/messages` | Transcript hydration | WorkerAuthGuard, ConsentGuard | No |
| `GET /chat/session/latest` | Latest session id | WorkerAuthGuard, ConsentGuard | No |

## 5.9 Voice Profiling APIs

| Method | Route | Purpose | Auth | AI |
|--------|-------|---------|------|-----|
| `POST /profiling/session` | Start voice profiling | WorkerAuthGuard, ConsentGuard | Yes |
| `POST /profiling/answer` | Submit voice answer | WorkerAuthGuard, ConsentGuard | Yes |
| `GET /profiling/session/:sessionId` | Read answers for review | WorkerAuthGuard, ConsentGuard | No |
| `POST /profiling/correct` | Change settled answer | WorkerAuthGuard, ConsentGuard | Yes |
| `POST /profiling/finalize` | Commit reviewed session | WorkerAuthGuard, ConsentGuard | No |

## 5.10 Voice Note APIs

| Method | Route | Purpose | Auth | AI |
|--------|-------|---------|------|-----|
| `POST /voice/upload-url` | Mint signed upload URL | WorkerAuthGuard, ConsentGuard | No |
| `POST /voice/upload` | Register voice note | WorkerAuthGuard, ConsentGuard | No |
| `POST /voice/transcribe` | Enqueue transcription | WorkerAuthGuard, ConsentGuard | Yes (STT) |
| `GET /voice/:voiceNoteId` | Read one voice note | WorkerAuthGuard, ConsentGuard | No |

## 5.11 Profile Extraction APIs

| Method | Route | Purpose | Auth | AI |
|--------|-------|---------|------|-----|
| `POST /profile/extract` | Enqueue profile extraction | WorkerAuthGuard, ConsentGuard | Yes (BullMQ) |
| `POST /profile/confirm` | Confirm extracted profile | WorkerAuthGuard, ConsentGuard | No |
| `GET /workers/me/ai-jobs/:id` | Poll async AI job status | WorkerAuthGuard, ConsentGuard | No |

## 5.12 Resume APIs

| Method | Route | Purpose | Auth | AI |
|--------|-------|---------|------|-----|
| `POST /resume/generate` | Generate resume | WorkerAuthGuard, ConsentGuard | Yes (LLM) |
| `GET /resume/:id` | Read generated resume | InternalServiceGuard | No |
| `POST /resume/:id/regenerate` | Re-run generation | InternalServiceGuard | Yes (LLM) |
| `GET /resume/:id/download` | Signed download URL | WorkerAuthGuard | No |
| `POST /resume/:id/share` | Record share event | WorkerAuthGuard, ConsentGuard | No |

## 5.13 Job Feed/Application APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /feed` | Worker job feed (ranked) | WorkerAuthGuard, ConsentGuard |
| `POST /applications/:jobId/apply` | Apply to job | WorkerAuthGuard, ConsentGuard |
| `POST /applications/:jobId/skip` | Skip job | WorkerAuthGuard, ConsentGuard |
| `GET /workers/me/applications` | My applications | WorkerAuthGuard, ConsentGuard |
| `GET /jobs/:jobId/applicants` | Ops: applicants per job | InternalServiceGuard |
| `GET /workers/:workerId/applications` | Ops: worker's decisions | InternalServiceGuard |
| `GET /jobs/search` | Free-text job search | WorkerAuthGuard, ConsentGuard |
| `GET /jobs/:jobId` | Worker-visible job detail | WorkerAuthGuard, ConsentGuard |

## 5.14 Feedback APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /workers/me/feedback/attachment/upload-url` | Mint signed upload slot | WorkerAuthGuard, ConsentGuard |
| `POST /workers/me/feedback` | Submit feedback | WorkerAuthGuard, ConsentGuard |

## 5.15 Actions APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /workers/me/actions` | Record one behavioral action | WorkerAuthGuard, ConsentGuard |
| `POST /workers/me/actions/batch` | Batch flush (max 100) | WorkerAuthGuard, ConsentGuard |

## 5.16 Notification APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /workers/me/notifications` | Worker alerts feed | WorkerAuthGuard, ConsentGuard |
| `POST /workers/me/notifications/read` | Mark alerts read | WorkerAuthGuard, ConsentGuard |
| `GET /workers/me/notification-prefs` | Read push toggle | WorkerAuthGuard, ConsentGuard |
| `PATCH /workers/me/notification-prefs` | Flip push toggle | WorkerAuthGuard, ConsentGuard |

## 5.17 Referral APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /referrals/attribute` | Attribute referral | WorkerAuthGuard |
| `GET /r/:code` | Resolve referral link | None |
| `POST /referrals/bonus/evaluate` | Ops: re-run bonus rule | InternalServiceGuard |
| `GET /referrals/bonus/status` | Ops: bonus status | InternalServiceGuard |

## 5.18 Payer Auth APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /payer/signup` | Create payer account | None (public, IP-limited) |
| `POST /payer/login/request` | Request login code | None (public, IP-limited) |
| `POST /payer/login/verify` | Verify, mint session | None (public, IP-limited) |
| `POST /payer/test-login` | QA: skip OTP | PayerTestLoginGuard |
| `POST /payer/refresh` | Refresh session | PayerAuthGuard |
| `POST /payer/logout` | Revoke session | PayerAuthGuard |

## 5.19 Payer Account APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /payer/me` | Own account | PayerAuthGuard |
| `PATCH /payer/me` | Self-edit org name/phone | PayerAuthGuard |

## 5.20 Payer Job Posting APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /payer/job-postings` | Create posting | PayerAuthGuard |
| `GET /payer/job-postings` | List own postings | PayerAuthGuard |
| `GET /payer/job-postings/:id` | Get own posting | PayerAuthGuard |
| `PATCH /payer/job-postings/:id` | Edit/publish | PayerAuthGuard |
| `POST /payer/job-postings/:id/close` | Close posting | PayerAuthGuard |
| `POST /payer/job-postings/:id/pause` | Pause posting | PayerAuthGuard |
| `POST /payer/job-postings/:id/resume` | Resume posting | PayerAuthGuard |
| `POST /payer/job-postings/:id/plan` | Buy plan | PayerAuthGuard |
| `POST /payer/job-postings/:id/boost` | Buy boost | PayerAuthGuard |
| `POST /payer/job-postings/:id/quota-topup` | Top up quota | PayerAuthGuard |

## 5.21 Payer Reach APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /payer/reach/jobs/:jobId/applicants` | Ranked candidates for owned job | PayerAuthGuard |

## 5.22 Payer Unlock/Credit APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /payer/unlocks` | Request contact unlock | PayerAuthGuard |
| `POST /payer/unlocks/:unlockId/reveal` | Reveal contact | PayerAuthGuard |
| `GET /payer/unlocks` | List own unlocks | PayerAuthGuard |
| `GET /payer/credits` | Credit balance | PayerAuthGuard |
| `GET /payer/credits/ledger` | Credit movement history | PayerAuthGuard |
| `POST /payer/credits` | Buy credit pack (MOCK) | PayerAuthGuard |
| `POST /payer/credits/order` | Create Razorpay order (REAL) | PayerAuthGuard |
| `POST /payer/credits/verify` | Verify payment | PayerAuthGuard |

## 5.23 Payer Disclosure APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /payer/resume-disclosures` | Request masked resume | PayerAuthGuard |
| `GET /payer/resume-disclosures` | List own disclosures | PayerAuthGuard |

## 5.24 Payer Pricing APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /payer/pricing/catalog` | Live product catalog | PayerAuthGuard |

## 5.25 Payer Org Member APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /payer/org/members` | List own org members | PayerAuthGuard, PayerOrgRoleGuard |
| `POST /payer/org/members` | Invite teammate (MOCK) | PayerAuthGuard, PayerOrgRoleGuard, @OrgRoles("owner") |
| `DELETE /payer/org/members/:id` | Remove teammate | PayerAuthGuard, PayerOrgRoleGuard, @OrgRoles("owner") |
| `POST /payer/org/invites/accept` | Accept teammate invite | PayerAuthGuard |

## 5.26 Payer Capacity APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /payer/capacity` | Own hiring capacity | PayerAuthGuard |
| `POST /payer/capacity` | Buy/upgrade capacity | PayerAuthGuard |

## 5.27 Payer Job Posting Chat APIs

| Method | Route | Purpose | Auth | AI |
|--------|-------|---------|------|-----|
| `POST /payer/job-posting-chat/session` | Start AI chat | PayerAuthGuard | Yes |
| `POST /payer/job-posting-chat/message` | Send message | PayerAuthGuard | Yes |
| `GET /payer/job-posting-chat/sessions` | List conversations | PayerAuthGuard | No |
| `GET /payer/job-posting-chat/sessions/:id/messages` | Hydrate transcript | PayerAuthGuard | No |
| `POST /payer/job-posting-chat/sessions/:id/publish` | Publish as posting | PayerAuthGuard | No |

## 5.28 Agency APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /payer/agency/jobs` | Create job | PayerAuthGuard, @PayerRoles("agent") |
| `GET /payer/agency/jobs` | List own jobs | PayerAuthGuard, @PayerRoles("agent") |
| `GET /payer/agency/jobs/:jobId` | Get one job | PayerAuthGuard, @PayerRoles("agent") |
| `PATCH /payer/agency/jobs/:jobId` | Edit job | PayerAuthGuard, @PayerRoles("agent") |
| `POST /payer/agency/jobs/:jobId/close` | Close job | PayerAuthGuard, @PayerRoles("agent") |
| `POST /payer/agency/jobs/:jobId/pause` | Pause job | PayerAuthGuard, @PayerRoles("agent") |
| `POST /payer/agency/jobs/:jobId/resume` | Resume job | PayerAuthGuard, @PayerRoles("agent") |
| `POST /payer/agency/invites` | Mint invite code | PayerAuthGuard, @PayerRoles("agent") |
| `POST /payer/agency/invites/batch` | Batch mint invites | PayerAuthGuard, @PayerRoles("agent") |
| `POST /payer/agency/invites/:code/click` | Record click | PayerAuthGuard, @PayerRoles("agent") |
| `GET /payer/agency/referrals/summary` | Funnel counts | PayerAuthGuard, @PayerRoles("agent") |
| `GET /payer/agency/workers` | Referred workers | PayerAuthGuard, @PayerRoles("agent") |
| `POST /payer/agency/kyc` | Submit/replace KYC | PayerAuthGuard, @PayerRoles("agent") |
| `GET /payer/agency/kyc` | Own KYC status | PayerAuthGuard, @PayerRoles("agent") |
| `GET /payer/agency/earnings` | Earnings analytics | PayerAuthGuard, @PayerRoles("agent") |
| `POST /payer/agency/payouts` | Request payout (MOCK) | PayerAuthGuard, @PayerRoles("agent") |
| `GET /payer/agency/payouts` | Payout history | PayerAuthGuard, @PayerRoles("agent") |

## 5.29 Agency KYC Ops APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /ops/agency-kyc/pending` | Pending KYC queue | InternalServiceGuard |
| `POST /ops/agency-kyc/:payerId/verify` | Verify KYC | InternalServiceGuard |
| `POST /ops/agency-kyc/:payerId/reject` | Reject KYC | InternalServiceGuard |

## 5.30 Admin Auth APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /admin/login/request` | Request admin login | None (public, IP-limited) |
| `POST /admin/login/verify` | Verify + MFA required | None (public, IP-limited) |
| `POST /admin/mfa/verify` | Verify TOTP, mint session | None (public, IP-limited) |
| `POST /admin/refresh` | Refresh session | AdminAuthGuard |
| `POST /admin/logout` | Revoke session | AdminAuthGuard |
| `GET /admin/me` | Admin identity + role | AdminAuthGuard |

## 5.31 Admin Action APIs

| Method | Route | Purpose | Auth | Capability |
|--------|-------|---------|------|------------|
| `POST /admin/payers/:id/suspend` | Suspend payer | AdminAuthGuard | suspend_payer |
| `POST /admin/payers/:id/reinstate` | Reinstate payer | AdminAuthGuard | suspend_payer |
| `POST /admin/payers/:id/credits` | Grant credits | AdminAuthGuard | grant_credits |
| `POST /admin/job-postings/:id/close` | Force-close posting | AdminAuthGuard | force_close_posting |
| `POST /admin/workers/:id/flag` | Flag worker | AdminAuthGuard | flag_worker |
| `POST /admin/workers/:id/unflag` | Unflag worker | AdminAuthGuard | flag_worker |
| `POST /admin/admins` | Invite new admin | AdminAuthGuard | manage_admins |
| `PATCH /admin/admins/:id/role` | Change admin role | AdminAuthGuard | manage_admins |
| `POST /admin/admins/:id/mfa/reset` | Reset admin MFA | AdminAuthGuard | manage_admins |
| `POST /admin/admins/:id/suspend` | Suspend admin | AdminAuthGuard | manage_admins |

## 5.32 Admin Entity APIs

| Method | Route | Purpose | Auth | Capability |
|--------|-------|---------|------|------------|
| `GET /admin/workers` | Faceless workers list | AdminAuthGuard | read_entities |
| `GET /admin/workers/:id` | Faceless worker detail | AdminAuthGuard | read_entities |
| `GET /admin/payers` | Faceless payers list | AdminAuthGuard | read_entities |
| `GET /admin/payers/:id` | Faceless payer detail | AdminAuthGuard | read_entities |
| `GET /admin/payers/:id/credits` | Payer credit balance | AdminAuthGuard | read_entities |
| `GET /admin/job-postings` | Faceless postings list | AdminAuthGuard | read_entities |
| `GET /admin/job-postings/:id` | Faceless posting detail | AdminAuthGuard | read_entities |
| `GET /admin/applications` | Faceless applications | AdminAuthGuard | read_entities |

## 5.33 Admin Event APIs

| Method | Route | Purpose | Auth | Capability |
|--------|-------|---------|------|------------|
| `GET /admin/events` | Keyset-paginated events | AdminAuthGuard | read_events |
| `GET /admin/events/metrics` | Dashboard aggregates | AdminAuthGuard | read_events |
| `GET /admin/events/export` | Bounded PII-free export | AdminAuthGuard | export |
| `GET /admin/events/trace/:correlationId` | Causal chain | AdminAuthGuard | read_events |
| `GET /admin/events/:id` | Full PII-free detail | AdminAuthGuard | read_events |
| `GET /admin/entities/:type/:id/timeline` | All events for subject | AdminAuthGuard | read_events |

## 5.34 Admin Dashboard/Finance APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /admin/dashboard/summary` | AI spend + platform volume | AdminAuthGuard |
| `GET /admin/finance/summary` | Credit position + orders | AdminAuthGuard |
| `GET /admin/finance/ledger` | Append-only credit ledger | AdminAuthGuard |
| `GET /admin/finance/orders` | Payment orders | AdminAuthGuard |

## 5.35 Admin Directory/Kill Switch APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /admin/admins` | Admin directory | AdminAuthGuard, manage_admins |
| `GET /admin/capabilities` | Role-to-capability matrix | AdminAuthGuard |
| `GET /admin/kill-switch/status` | Live switch state | AdminAuthGuard, toggle_kill_switch |
| `POST /admin/kill-switch/pause-request` | Record pause intent | AdminAuthGuard, toggle_kill_switch |

## 5.36 Admin PII/AI/Feedback/Journey APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `POST /admin/workers/:id/reveal-contact` | Reveal ONE worker phone | AdminAuthGuard, reveal_pii (flag-gated) |
| `GET /admin/feedback` | Worker feedback | AdminAuthGuard, read_entities |
| `GET /admin/ai-traces` | PII-free AI trace metadata | AdminAuthGuard, read_ai_traces |
| `GET /admin/ai-traces/:id` | DECRYPTED AI trace detail | AdminAuthGuard, read_ai_traces |
| `GET /admin/workers/:id/journey-summary` | 7-step funnel | AdminAuthGuard, read_entities |
| `GET /admin/workers/:id/chat-sessions` | Interview sessions | AdminAuthGuard, read_entities |
| `GET /admin/chat-sessions/:id` | One session in depth | AdminAuthGuard, read_entities |

## 5.37 Admin Skill Discovery APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /admin/skill-discovery` | Review queue | AdminAuthGuard, read_entities |
| `GET /admin/skill-discovery/metrics` | Queue tiles | AdminAuthGuard, read_entities |
| `GET /admin/skill-discovery/groups` | Review batches | AdminAuthGuard, read_entities |
| `GET /admin/skills` | Canonical skills for picker | AdminAuthGuard, read_entities |
| `GET /admin/skill-discovery/:id` | One candidate detail | AdminAuthGuard, read_entities |
| `GET /admin/skill-discovery/:id/audit` | Audit trail | AdminAuthGuard, read_entities |
| `POST /admin/skill-discovery/:id/decision` | Approve/reject/hold | AdminAuthGuard, review_skill_candidates |

## 5.38 Internal/Ops APIs

| Method | Route | Purpose | Auth |
|--------|-------|---------|------|
| `GET /health` | Readiness probe | None |
| `GET /events` | Event stream | InternalServiceGuard |
| `GET /pricing/catalog` | Active pricing catalog | InternalServiceGuard |
| `PUT /pricing/catalog` | Publish new catalog | InternalServiceGuard |
| `GET /pricing/quote` | Preview resolved price | InternalServiceGuard |
| `POST /unlocks` | Request routed-contact unlock | InternalServiceGuard |
| `POST /unlocks/:unlockId/reveal` | Reveal granted unlock | InternalServiceGuard |
| `GET /unlocks` | List unlocks by payer | InternalServiceGuard |
| `GET /unlocks/:unlockId` | Get single unlock | InternalServiceGuard |
| `GET /payers/:payerId/credits` | Payer credit balance | InternalServiceGuard |
| `POST /payers/:payerId/credits` | MOCK credit-pack purchase | InternalServiceGuard |
| `POST /resume-disclosures` | Request masked resume | InternalServiceGuard |
| `GET /resume-disclosures` | List disclosures by payer | InternalServiceGuard |
| `GET /internal/skills/nearest` | Skill nearest-neighbor | InternalServiceGuard |
| `POST /internal/skills/embed` | Skill alias embedding | InternalServiceGuard |
| `GET /internal/occupation/resolve` | Occupation resolution | InternalServiceGuard |
| `POST /internal/occupation/resolve` | Occupation resolution (POST) | InternalServiceGuard |
| `POST /payments/razorpay/webhook` | Razorpay webhook | RazorpayWebhookGuard (HMAC) |
| `POST /job-postings` | Create vacancy-banded posting | InternalServiceGuard |
| `GET /job-postings` | List postings | InternalServiceGuard |
| `GET /job-postings/:id` | Get one posting | InternalServiceGuard |
| `PATCH /job-postings/:id` | Edit/publish posting | InternalServiceGuard |
| `POST /job-postings/:id/close` | Close posting | InternalServiceGuard |
| `POST /job-postings/:id/verify` | Mark verified | InternalServiceGuard |
| `POST /job-postings/:id/reject` | Mark rejected | InternalServiceGuard |
| `POST /job-postings/:id/reach/widen` | Widen reach set | InternalServiceGuard + AdminAuthGuard |
| `POST /job-postings/:id/plan` | Buy plan (ops) | InternalServiceGuard |
| `POST /job-postings/:id/boost` | Buy boost (ops) | InternalServiceGuard |
| `GET /reach/jobs/:jobId/applicants` | Ranked applicant pool | InternalServiceGuard |
| `GET /reach/workers/:workerId/feed` | Ranked job feed | InternalServiceGuard |
| `GET /pace/alerts` | PACE supply-widening alerts | InternalServiceGuard |
| `GET /workers` | Worker list | InternalServiceGuard |

---

# PART VI — AI/LLM AUDIT

## 6.1 Complete AI Call Map

| Task Type | API Endpoint | AI Service Endpoint | Model | Provider | Prompt Location | Active |
|-----------|-------------|---------------------|-------|----------|----------------|--------|
| `profile_extraction` | `POST /profile/extract` | `POST /profile/extract` | gemini-2.5-flash | Gemini | `profiling/prompts.py` | Yes (mock by default) |
| `profile_parse` | `POST /profile/extract` | `POST /profile/parse` | gemini-2.5-flash | Gemini | `profiling/parse_prompt.py` | Yes (mock by default) |
| `profiling_chat_turn` | `POST /chat/message` | `POST /profiling/respond` | gemini-2.5-pro | Gemini | `profiling/interview_prompts.py` | Yes (mock by default) |
| `resume_generation` | `POST /resume/generate` | `POST /resume/generate` | gemini-2.5-flash | Gemini | `profiling/prompts.py` | Yes (mock by default) |
| `skill_embedding` | — | `POST /skills/embed` | gemini embedding | Gemini | N/A | Yes (mock by default) |
| `skill_canonicalization` | — | `POST /skills/canonicalize` | gemini-2.5-flash | Gemini | N/A | Yes (mock by default) |
| `voice_transcription` | `POST /voice/transcribe` | `POST /voice/transcribe` | saarika:v2.5 | Sarvam | N/A | Yes |
| `voice_translation` | — | (inline) | mayura:v1 | Sarvam | N/A | Yes |
| `text_to_speech` | — | (CLI only) | bulbul:v2 | Sarvam | N/A | CLI only |
| `job_posting_chat_turn` | `POST /payer/job-posting-chat/message` | `POST /job-posting-chat/turn` | gemini-2.5-flash | Gemini | `job_posting_chat/prompts.py` | Deterministic (no LLM yet) |

## 6.2 AI Provider Routing

The `AIRouter` (`apps/ai-service/app/ai/router.py`) is the single LLM entry point:

1. Task type → tier mapping (cheap/capable/pro)
2. Kill switch check (`AI_KILL_SWITCH_ENABLED`)
3. Provider cooldown check (429 handling)
4. Spend ledger pre-check (daily/user/cumulative caps)
5. Retry loop: Gemini first, Anthropic fallback
6. Mock fallback when all providers fail

### Model Configuration

| Tier | Model | Used For |
|------|-------|----------|
| cheap | gemini-2.5-flash-lite | Low-cost tasks |
| capable | gemini-2.5-flash | Profile extraction, resume generation, skill canonicalization |
| pro | gemini-2.5-pro | Interview chat turns |
| fallback | claude-haiku-4-5 | When Gemini fails |

## 6.3 AI Safety Controls

| Control | Default | Effect |
|---------|---------|--------|
| `AI_ENABLE_REAL_CALLS` | false | ALL LLM calls return mock data |
| `AI_REAL_CALL_TASKS` | (empty) | No tasks go real even when real calls enabled |
| `AI_REAL_CALLS_KILL_SWITCH` | false | Emergency off switch |
| `AI_MAX_CALL_COST_INR` | 10 | Hard per-call cap |
| `AI_MAX_DAILY_COST_INR` | 200 | Global daily cap |
| `AI_MAX_USER_DAILY_COST_INR` | 25 | Per-user daily cap |
| `AI_MAX_TOTAL_COST_INR` | 1000 | Total cost cap |

## 6.4 AI Service Isolation (Testing)

Three-layer test isolation in `conftest.py`:
1. **Layer 1:** Pins every `Settings` flag to off/empty (~40 env vars)
2. **Layer 2:** Monkey-patches `socket.socket.connect` to raise `OutboundNetworkBlocked` for non-loopback
3. **Layer 3:** Clears `ai_internal_token` to prevent auth middleware 401s

---

# PART VII — PROMPT INVENTORY

## 7.1 Worker Profiling Prompts

| Prompt | Location | Purpose | Model |
|--------|----------|---------|-------|
| Extraction system prompt | `apps/ai-service/app/profiling/prompts.py` | Phase C enrichment — extract structured profile from messy text | gemini-2.5-flash |
| Parse system prompt | `apps/ai-service/app/profiling/parse_prompt.py` | "Type and cite" paradigm — extract from answer map with provenance | gemini-2.5-flash |
| Interview system prompt | `apps/ai-service/app/profiling/interview_prompts.py` | "Bada Bhai" conversational persona (generated from `persona.json`) | gemini-2.5-pro |

## 7.2 Job Posting Chat Prompts

| Prompt | Location | Purpose | Model |
|--------|----------|---------|-------|
| `JOB_POSTING_SYSTEM_PROMPT` | `apps/ai-service/app/job_posting_chat/prompts.py` | Employer-facing, plain professional English | gemini-2.5-flash |
| `build_job_posting_chat_messages()` | Same file | Rephrase turn message builder | gemini-2.5-flash |

## 7.3 Prompt Registry

Each prompt has a content-hash version. Optional Langfuse managed prompts (when `LANGFUSE_PROMPTS_ENABLED=true`). Local prompt is always authoritative.

---

# PART VIII — PROFILE EXTRACTION DEEP AUDIT

## 8.1 Three Extraction Approaches

### Approach 1: Legacy Transcript Extraction (DORMANT)

**Entry:** `POST /profile/extract` → `AiService.extractProfile()` → AI service `/profile/extract`

**Method:** Send full conversation transcript to LLM, get structured profile back.

**Flow:**
1. API receives extraction request
2. Builds conversation messages from DB + Redis buffer
3. Redacts worker name
4. Calls AI service `/profile/extract` with transcript
5. AI service pseudonymizes → calls LLM → validates → returns `WorkerProfileDraft`
6. API writes `worker_profiles` + `worker_attributes`

**When used:** When no answer map exists (legacy sessions only)

**Status:** DORMANT — all new sessions produce answer maps via the deterministic engine

### Approach 2: OIE Deterministic Parse (ACTIVE - PRIMARY)

**Entry:** `POST /profile/extract` → `AiService.parseProfile()` → AI service `/profile/parse`

**Method:** Send answer map (from deterministic interview) to LLM with "type and cite" prompt.

**Flow:**
1. API receives extraction request with answer map
2. Builds message with answer map + pack metadata
3. Calls AI service `/profile/parse`
4. AI service pseudonymizes → calls LLM with parse prompt → validates against 6 gates:
   - **Provenance:** Value must be a literal substring of the transcript
   - **Role:** Must be a known canonical role id
   - **Type/range:** Numeric fields within plausible bounds
   - **Agreement:** Cross-field consistency checks
   - **Vocabulary:** Skill/machine ids in closed corpus
   - **PII:** No residual PII in extracted values
5. Returns parsed profile fields

**When used:** When answer map exists (all new sessions)

**Status:** ACTIVE — the primary extraction path

### Approach 3: Interview Overlay (Phase C) (ACTIVE - SUPPLEMENTARY)

**Entry:** `AiService.extractInterview()` → AI service `/profiling/extract`

**Method:** LLM extracts experiences, skills, domain labels from conversation.

**Flow:**
1. After Approach 2 completes, API calls this as overlay
2. AI service processes conversation for additional context
3. Extracts: work experiences, additional skills, domain labels
4. Merges with Approach 2 output

**When used:** After OIE parse, as supplementary data

**Status:** ACTIVE — runs alongside Approach 2

## 8.2 Active Extraction Flow (Complete)

```
1. Chat Interview Completes
   → ChatService.finalizeInterview()
   → ONE Postgres transaction: insert messages + pack answers
   → Emit profile.extraction_ready
   → Enqueue profile-extraction BullMQ job

2. ProfileExtractionProcessor Runs
   → Idempotency check (ai_job already completed?)
   → Mark ai_job as running
   → Build conversation messages from DB + Redis buffer
   → Redact worker name from transcript
   → Determine extraction path:
     - If answer map exists → call ai.parseProfile() (OIE path)
     - If no answer map → call ai.extractProfile() (legacy path)
   → Apply 6 parse gates as "second wall"
   → Call ai.extractInterview() for Phase C overlay
   → projectProfile() merges all sources
   → Write worker_profiles row (idempotent on ai_job_id)
   → Upsert worker_attributes (319+ rows)
   → Mark ai_job as completed
   → Rebuild match projections
   → Emit profile.extraction_completed
   → Record AI cost/trace
```

## 8.3 Domain Matching During Extraction

1. Embed worker's trade/skill/machine phrases
2. Retrieve top-K nearest domain aliases from catalog (via HTTP to API)
3. Apply floor filter (`domain_match_floor`)
4. Auto-match if clear winner (above `domain_match_auto_floor` and margin)
5. Otherwise: `UNMATCHED_LLM_DECLINED` (ambiguous — interview resolves it)
6. OR: use pinned `job_domain_id` from interview (short-circuits everything)

---

# PART IX — RESUME GENERATION DEEP AUDIT

## 9.1 Two Resume Generation Approaches

### Approach 1: LLM-Generated Structured Resume (ACTIVE)

**Entry:** `POST /resume/generate` → `ResumeService.generate()`

**Method:** Send structured profile to LLM, get structured resume JSON.

**Flow:**
1. Rate-limited (daily cap per worker)
2. Decrypt worker name server-side (never in AI call)
3. Call `ai.generateResume()` with structured profile (no name/phone)
4. Validate response against contracts
5. Create resume row (idempotent)
6. Enqueue async PDF render

**Template selection:** Based on `trade` field:
- `bb_trade` (v1) for trade workers
- `classic`/`modern`/`minimal` (v3) for others
- `fallback` (v3) when template lookup fails

**PDF rendering (ResumeRenderProcessor):**
1. Decrypt name + phone server-side
2. Fetch profile photo (if `resumeShowPhoto` enabled)
3. Build trade sheet context (attributes, employment, quotes)
4. Build QR code (links to profile origin)
5. Render PDF via WeasyPrint HTML→PDF
6. Upload to Supabase Storage `worker-resumes` bucket
7. Update resume row to "rendered"

**Templates:**
- `bb_trade.v1.html` — A4, navy masthead, QR to live profile
- `classic.v1.html` through `v3.html` — Traditional layout
- `modern.v1.html` through `v3.html` — Modern layout
- `minimal.v1.html` through `v3.html` — Minimal layout
- `fallback.v1.html` through `v3.html` — Generic fallback

### Approach 2: Deterministic Resume Builder (DORMANT)

**Entry:** `extraction.py` in AI service

**Method:** Build resume from profile fields without LLM.

**Status:** DORMANT — exists as fallback but not called in production flow

---

# PART X — MATCHING ENGINE DEEP AUDIT

## 10.1 Three Matching Systems

### System 1: Match Engine V1 (ACTIVE - Worker Feed)

**Package:** `packages/match-engine`

**Algorithm:** Pure lexicographic ranking (no scoring dials)

**Rank key:** `tier|skillMonths|industryMonths|lastWorked|lastActive|workerId`

**Config (9 values):**
- `SKILL_WEIGHT=1` (component of rank key, not score multiplier)
- `INDUSTRY_WEIGHT=1`
- `TENURE_MONTHS=6` (bucketing interval)
- `MAX_RESULTS=50`
- `REACH_SET_SIZE=200`
- `TIER_ORDER=["A","B","C"]`
- `DECAY_MONTHS=6`
- `FRESHNESS_DAYS=90`
- `STALE_PENALTY=0.5`

**Used for:** Worker job feed (`GET /feed`)

### System 2: Reach Engine (ACTIVE - Employer List)

**Package:** `packages/reach-engine`

**Algorithm:** Weighted scoring (6 factors)

**Weights:**
- `role=0.35`
- `distance=0.20`
- `skills=0.15`
- `experience=0.15`
- `pay=0.10`
- `availability=0.05`
- `activity=0.00` (engagement is in match-engine, not here — prevents double-counting)

**Used for:** Employer-facing candidate lists (`GET /reach/jobs/:id/applicants`)

**Design decisions:**
- `activity=0.00` is load-bearing: engagement is a first-class ranking signal (CLAUDE.md product principle #4) but implemented in match-engine's rank key, not here
- `HOT_TOP_RATIO=0.12` — top 12% marked as "hot"
- `sortNeverBlock` — ranking never excludes, only reorders

### System 3: Reach Learn (DORMANT)

**Package:** `packages/reach-learn`

**Algorithm:** Coordinate-ascent calibration of reach-engine weights using NDCG/MAP/MRR

**Safety:** `widenNeverNarrow` guardrail — new weights must not reduce hot/warm set by >5% relative

**Status:** DORMANT — infrastructure exists but not actively calibrating

## 10.2 Worker Feed Flow

```
Worker opens job feed
  → GET /feed
  → MatchFeedService:
    1. Query open job postings
    2. Overfetch 3x
    3. Apply match-engine rankCandidates() (lexicographic)
    4. interleaveMaxPerCompany() (max 2 consecutive per company)
    5. Emit feed.shown_v2 per card
    6. Return faceless results (opaque ids + ranking signals)
```

## 10.3 Employer Candidate Flow

```
Employer views candidates for a job
  → GET /payer/reach/jobs/:jobId/applicants
  → ReachService.applicantsForOwnedJob():
    1. Query worker pool for this job's reach set
    2. Apply reach-engine scoreCandidate() (weighted sum)
    3. rankByScore() with HOT_TOP_RATIO=0.12
    4. Return faceless ranked rows
```

## 10.4 Application Snapshot (Frozen Rank)

When a worker applies:
1. `buildSnapshot()` computes frozen rank inputs at decision time
2. `upsertDecision()` single SQL with `ON CONFLICT`
3. Snapshot is frozen on INSERT and skip→apply FLIP only
4. Profile edits never reorder paid lists

---

# PART XI — CHAT/INTERVIEW ARCHITECTURE

## 11.1 Dual-Phase Interview System

### Phase A (LLM-led): Authored Trades

- Deterministic question selection from 466 pack items
- LLM only handles "stretch" questions (un-authored trades)
- Gate ownership: engine serves gate, model writes question
- Caps: MAX_LLM_ASKS=20, MAX_EXPERIENCE_ENTRIES=5

### Phase B (Chat): General Profiling

- Conversation-style interview
- Redis-buffered transcript (zero Postgres writes mid-interview)
- Flushes ONCE at session end

## 11.2 Session Lifecycle

```
1. Worker taps "Start Interview"
   → POST /chat/session
   → Creates/reattaches to active session (#1197)
   → Returns one-shot composite opener (static, not LLM — OIE Phase 8)

2. Worker sends messages
   → POST /chat/message
   → Redis buffer (zero DB writes)
   → Orchestrator decides next question:
     - Layer A: reply cache / replay defense
     - Layer B: CAS write on Redis
   → Returns AI reply

3. Session ends (max turns / worker ends / abandonment)
   → finalizeInterview():
     - ONE Postgres transaction
     - Insert all messages
     - Insert pack answer rows
     - Emit events
     - Enqueue profile extraction

4. Abandonment sweep (hourly)
   → Closes idle sessions (>6h)
   → Recovers transcripts from Redis before TTL expiry
```

## 11.3 Redis Buffer Architecture

- Key: `chat:transcript:{sessionId}`
- Structure: List of message objects
- TTL: 24 hours (`CHAT_TRANSCRIPT_TTL_SECONDS=86400`)
- Flush: ONCE at session end (transactional)
- Race condition defense: CAS (Compare-And-Swap) on Redis

## 11.4 Turn Outcome Types

Six discriminated union outcomes:
- `session_over` — Interview complete
- `reflushed` — Buffer flushed
- `unavailable` — Service degraded
- `degraded` — Partial failure
- `replay` — Double-submit defense
- `turn` — Normal turn

---

# PART XII — VOICE/AUDIO PIPELINE

## 12.1 Complete Audio Flow

```
1. Worker records voice note
   → Flutter app records AAC-LC audio (max 120s)

2. Upload
   → POST /voice/upload-url (mint signed URL)
   → Worker uploads to Supabase Storage
   → POST /voice/upload (register metadata, verify object exists)

3. Transcription
   → POST /voice/transcribe (enqueue BullMQ job)
   → VoiceTranscriptionProcessor:
     a. Download audio from storage
     b. Chunk if >30s (AAC-LC frame boundary splitting)
     c. Call Sarvam STT (saarika:v2.5)
     d. Redact spoken digits (phone detection)
     e. Translate to English (Sarvam mayura:v1)
     f. Pseudonymize
     g. Persist transcript on voice_notes row
     h. Emit voice_note.transcription_completed

4. Processing
   → Transcript used by profiling engine
   → Or stored for voice note display
```

## 12.2 Voice Profiling Form

- Separate from voice notes
- Structured Q&A (one answer per question)
- Max 30s per answer (`MAX_PROFILING_ANSWER_SECONDS`)
- Deterministic interview engine controls flow
- Each answer: record → upload → transcribe → parse

---

# PART XIII — QUEUES/BACKGROUND JOBS

## 13.1 12 BullMQ Queues

| # | Queue | Type | Schedule | Dry-Run Gate | Purpose |
|---|-------|------|----------|--------------|---------|
| 1 | `profile-extraction` | Event-driven | Per-interview | N/A | Run AI profile extraction |
| 2 | `voice-transcription` | Event-driven | Per-voice-note | N/A | Transcribe audio |
| 3 | `resume-generate` | Event-driven | Post-confirm | N/A | Auto-generate resume |
| 4 | `resume-render` | Event-driven | Per-render | N/A | Render PDF via WeasyPrint |
| 5 | `worker-push` | Event-driven | Per-notification | N/A | Deliver push notifications |
| 6 | `referral-bonus` | Event-driven | Post-confirm/unlock | N/A | Evaluate activation bonus |
| 7 | `account-deletion` | **Repeatable sweep** | Configurable hours | No (always armed) | DPDP erasure sweep |
| 8 | `ai-jobs-retention` | **Repeatable sweep** | Configurable hours | Yes | Prune old AI jobs |
| 9 | `chat-abandonment` | **Repeatable sweep** | Configurable hours | No (always armed) | Close idle sessions |
| 10 | `reach-widen-expiry` | **Repeatable sweep** | Configurable hours | Yes | Expire reach widenings |
| 11 | `learn-labels` | **Repeatable sweep** | Configurable hours | Yes | Drain events to training labels |
| 12 | `pace-waves` | **Delayed job** | 6-24h cadence | N/A | Supply-widening waves |

## 13.2 Queue Configuration

- Default attempts: 3
- Backoff: exponential starting at 1s
- `removeOnComplete: 1000`
- `removeOnFail: 5000`
- `maxRetriesPerRequest: null` (required by BullMQ blocking commands)

## 13.3 Retry Postures

1. **Bounded retry ladder** (5 attempts, [1s, 5s, 15s, 60s]) — account-deletion and chat-abandonment sweeps
2. **Single attempt + warn** — ai-jobs-retention, reach-widen-expiry, learn-labels sweeps
3. **Default BullMQ retries** (3 attempts, exponential) — all event-driven processors

---

# PART XIV — REDIS USAGE

## 14.1 Key Patterns

| Key Pattern | Data Structure | Purpose | TTL |
|-------------|---------------|---------|-----|
| `chat:transcript:{sessionId}` | List | Interview message buffer | 24h |
| `rate:{key}` | Sorted set | Rate limiting | 1h window |
| `otp:{phone}` | Hash | OTP storage | 5min |
| `session:{workerId}` | Hash | Session metadata | 30d |
| `idempotency:{key}` | String | Idempotency guard | 24h |
| `ai:cooldown:{provider}` | String | Provider rate-limit cooldown | Variable |
| `ai:spend:{scope}` | Hash | Spend ledger (daily/user) | 24h |
| `pace:state:{jobId}` | Hash | PACE wave state | Session |
| `worker:actions:{workerId}` | Sorted set | Action rate limit | 1h window |

## 14.2 Redis Configuration

- AOF persistence (`appendonly yes`)
- `appendfsync everysec`
- `noeviction` policy (never drop keys under memory pressure)
- Canary test at deploy time

---

# PART XV — STORAGE

## 15.1 Buckets

| Bucket | Purpose | Access | Contents | Dormancy |
|--------|---------|--------|----------|----------|
| `worker-conversations` | DSAR erasure target | Service-role | Chat transcripts | Active |
| `worker-resumes` | Resume PDFs | Service-role | `resumes/{workerId}/{resumeId}/v{version}.pdf` | Active |
| `interview-kits` | Interview kit PDFs | Service-role | Trade-specific prep materials | Active |
| `voice-notes` | Voice recordings | Service-role | `voice-notes/{workerId}/{uuid}.m4a` | Dormant when empty |
| `worker-photos` | Profile photos | Service-role | `worker-photos/{workerId}/{uuid}.{ext}` | Dormant when empty |
| `feedback-attachments` | Feedback images | Service-role | `feedback-attachments/{workerId}/{uuid}.jpg` | Dormant when empty |

## 15.2 Storage Operations

- **Upload:** Signed upload URLs (Supabase Storage REST API)
- **Download:** Signed URLs with TTL (900s default)
- **Delete:** Paginated prefix deletion for DSAR erasure
- **Object existence:** HEAD call verification
- **Magic bytes:** JPEG/PNG validation for photos

---

# PART XVI — AUTHENTICATION & AUTHORIZATION

## 16.1 Four Auth Paths

| Path | Mechanism | Token | TTL | Roles |
|------|-----------|-------|-----|-------|
| Worker | Phone OTP → JWT | Bearer JWT | 30d | Worker |
| Payer | Email OTP → JWT | Bearer JWT (httpOnly cookie) | Configurable | Employer/Agent, Owner/Recruiter |
| Admin | Email OTP → MFA TOTP → JWT | Bearer JWT (httpOnly cookie) | Configurable | Admin roles (RBAC) |
| Internal | Service token | `x-internal-service-token` header | Permanent | Ops |

## 16.2 Authorization Guards

| Guard | Purpose |
|-------|---------|
| `WorkerAuthGuard` | Validates JWT, resolves worker |
| `ConsentGuard` | Checks DPDP consent for specific purpose |
| `PayerAuthGuard` | Validates payer JWT, resolves payer |
| `PayerRoleGuard` | Checks employer/agent role |
| `PayerOrgRoleGuard` | Checks owner/recruiter role |
| `AdminAuthGuard` | Validates admin JWT |
| `AdminRolesGuard` | Checks admin capability (RBAC) |
| `InternalServiceGuard` | Validates service token |
| `RazorpayWebhookGuard` | HMAC signature verification |
| `TestLoginGuard` | QA-only test login (flag-gated) |
| `PayerTestLoginGuard` | QA-only payer test login (flag-gated) |

## 16.3 Admin RBAC Capabilities

| Capability | Description |
|------------|-------------|
| `read_events` | View event audit log |
| `read_entities` | View workers/payers/jobs |
| `read_ai_traces` | View AI call traces (super_admin only) |
| `manage_admins` | Invite/change/suspend admins (super_admin only) |
| `grant_credits` | Grant credits to payers |
| `review_skill_candidates` | Approve/reject skill discoveries |
| `toggle_kill_switch` | Pause platform operations |
| `reveal_pii` | Reveal worker phone (flag-gated) |
| `export` | Export events |
| `flag_worker` | Flag/unflag workers |
| `force_close_posting` | Force-close job postings |
| `suspend_payer` | Suspend/reinstate payers |

## 16.4 PII Protection

- Worker phone: AES-256-GCM encrypted at rest, HMAC hashed for lookups
- Payer email: AES-256-GCM encrypted at rest
- Admin secrets: Separate JWT secret from workers
- PIN: scrypt slow KDF with separate pepper
- Key rotation: TD22-1 keyring support (v1/v2 tokens)

---

# PART XVII — FEATURE FLAGS

## 17.1 Complete Feature Flag Inventory

| Flag | Default | Effect | Status |
|------|---------|--------|--------|
| `PAYMENTS_ENABLE_REAL` | false | Real Razorpay payments | DORMANT (mock active) |
| `MESSAGING_ENABLE_REAL` | false | Real WhatsApp sends | DORMANT |
| `PUSH_ENABLE_REAL` | false | Real FCM push | DORMANT |
| `MATCH_V1_ENABLED` | false | Matching V1 engine | DORMANT |
| `CAPACITY_ENFORCEMENT_ENABLED` | false | Capacity limits | DORMANT |
| `PACE_ENABLED` | false | Supply-widening | DORMANT |
| `DOMAIN_MATCH_ENABLED` | false | ANN domain matching | DORMANT |
| `SKILL_CANONICALIZE_ENABLED` | false | Skill canonicalization | DORMANT |
| `CHAT_LLM_INTERVIEW_ENABLED` | true | LLM-led interview | ACTIVE |
| `TEST_LOGIN_ENABLED` | false | Worker test-login seam | QA only |
| `PAYER_TEST_LOGIN_ENABLED` | false | Payer test-login seam | QA only |
| `AI_ENABLE_REAL_CALLS` | false | Real LLM calls | DORMANT (mock active) |
| `RESUME_RENDER_ENABLED` | false | WeasyPrint PDF render | DORMANT |
| `AGENCY_PAYOUTS_ENABLED` | false | Agency payouts | DORMANT |
| `MEMBER_INVITES_ENABLE_REAL` | false | Real invite emails | DORMANT |
| `AUTH_ROLLING_TIERS_ENABLED` | false | Rolling auth tiers | DORMANT |
| `AI_JOBS_RETENTION_DELETE_ENABLED` | false | AI jobs retention deletion | DORMANT |
| `TEST_IMMEDIATE_DELETE_ENABLED` | false | Immediate account deletion | QA only |
| `REACH_WIDEN_EXPIRY_ENABLED` | false | Reach widen expiry sweep | DORMANT |
| `LEARN_LABELS_ENABLED` | false | Learn labels sweep | DORMANT |
| `PACE_ADJACENCY_ENABLED` | false | PACE adjacency widening | DORMANT |

---

# PART XVIII — MOCK/REAL AUDIT

## 18.1 Everything That Can Run in Mock Mode

| Component | Mock Behavior | Real Behavior | Gate |
|-----------|--------------|---------------|------|
| LLM calls | Return canned responses | Call Gemini/Anthropic | `AI_ENABLE_REAL_CALLS` |
| Profile extraction | Return empty draft | Full LLM extraction | `AI_ENABLE_REAL_CALLS` |
| Resume generation | Return canonical skill names | Full LLM generation | `AI_ENABLE_REAL_CALLS` |
| Skill embedding | Return deterministic vectors | Gemini embedding | `AI_ENABLE_REAL_CALLS` |
| Skill canonicalization | Return empty results | LLM canonicalization | `AI_ENABLE_REAL_CALLS` |
| Payments | Return mock order IDs | Razorpay integration | `PAYMENTS_ENABLE_REAL` |
| Messaging | Log instead of send | WhatsApp Cloud API | `MESSAGING_ENABLE_REAL` |
| Push notifications | Log instead of send | FCM integration | `PUSH_ENABLE_REAL` |
| Member invites | Skip email send | ZeptoMail/SMTP | `MEMBER_INVITES_ENABLE_REAL` |
| Agency payouts | Mock payout records | Real payout processing | `AGENCY_PAYOUTS_ENABLED` |
| Resume PDF render | Leave status pending | WeasyPrint rendering | `RESUME_RENDER_ENABLED` |

## 18.2 Active Mock Under Current Configuration

With ALL feature flags at defaults:
- **ALL LLM calls are mocked** (no real AI processing)
- **ALL payments are mocked** (no real money movement)
- **ALL messaging is mocked** (no real WhatsApp sends)
- **ALL push is mocked** (no real FCM pushes)
- **Resume rendering is off** (PDFs not generated)
- **Voice notes are off** (bucket unset)

---

# PART XIX — OBSERVABILITY/LANGFUSE

## 19.1 Langfuse Integration

**Provider:** Langfuse (OpenTelemetry-based, v4)

**Three-level hierarchy:**
1. WORKFLOW — Top-level operation
2. TASK — Individual step within workflow
3. GENERATION — Single LLM call

**Privacy mask:** Runs on all traced values (PII stripped before Langfuse)

**Fail-open:** Tracing never breaks the flow

## 19.2 Event Audit Trail

Every important business action emits a validated event to the `events` table. Events carry:
- `eventId` (UUID)
- `eventType` (discriminated union)
- `aggregateId` (entity reference)
- `version` (forward-compatible)
- `timestamp`
- `metadata` (actorId, actorType, traceId, causationId)
- `payload` (typed per event type)

## 19.3 AI Cost Tracking

Every LLM call records:
- `ai_cost_records` — provider, model, tokens, cost_inr
- `ai_traces` — encrypted prompt/completion, duration_ms

---

# PART XX — TESTING AUDIT

## 20.1 Coverage Summary

| Area | Tests | Coverage | Gaps |
|------|-------|----------|------|
| API auth | 14 files | High | None visible |
| Profiling engine | 37 files | High | Golden tests, simulations |
| Matching | 20 files + 12 package | High | Rank parity, boost fences |
| Profile extraction | 14 files | Medium | No real AI tests |
| Payer portal | 89 files | High | No browser tests |
| Admin portal | 49 files | Medium | No browser tests |
| Chat | 6 files | Medium | No Redis integration tests |
| Voice | 5 files + AI tests | Medium | No real STT tests |
| Payments | 13 files | High | Razorpay webhook tested |
| DB schema | 107 files | Very High | Schema integrity, RLS |
| E2E | 13 files | Medium | No real OTP, no real AI |
| AI service | 72 files | High | All mocked (by design) |
| Flutter worker | 185 files | High | Widget/bloc tests |
| Contract tests | 0 files | None | Placeholder |
| Security tests | 0 files | None | Placeholder |
| Browser E2E | 0 files | None | No Playwright/Cypress |
| Load testing | 0 files | None | No k6/Artillery |
| Marketing web | 1 file | Minimal | Nearly untested |
| Ops web | 7 files | Low | Only mapping functions |

## 20.2 Test Quality Observations

**Strengths:**
- Three-layer AI test isolation (env pinning + socket guard + auth neutralization)
- 107 DB schema tests (unusually thorough)
- Privacy assertions at every layer
- Coverage thresholds enforced (75/75/73/75)
- E2E with real Postgres + Redis

**Gaps:**
- No contract tests (TypeScript Zod ↔ Python Pydantic parity)
- No security tests (cross-service PII containment)
- No browser E2E (Playwright/Cypress)
- No load testing
- No mutation testing

---

# PART XXI — SECURITY OBSERVATIONS

## 21.1 PII Handling

- Worker phone: AES-256-GCM encrypted at rest
- Payer email: AES-256-GCM encrypted at rest
- Worker name: Encrypted at rest, decrypted server-side only for PDF rendering
- HMAC hashing for lookups (phone, IP)
- PII never crosses AI boundaries (pseudonymization gateway)
- PII never appears in events/logs (opaque ids only)
- Faceless applicant feeds (no worker names to employers)

## 21.2 Authentication Security

- OTP brute-force protection (max attempts, cooldowns, hourly/daily caps)
- Global SMS kill-switch (`OTP_GLOBAL_MAX_SENDS_PER_DAY`)
- PIN slow KDF (scrypt)
- Separate JWT secrets for workers and admins
- MFA required for admin access
- Session rotation on refresh
- Device revocation

## 21.3 Potential Concerns

- WeasyPrint spawns a subprocess — if the process leaks, PII (name/phone) could be exposed
- Redis AOF persistence is not encrypted
- Supabase Storage signed URLs have configurable TTL
- Test-login seams are flag-gated but exist in code

---

# PART XXII — DEPENDENCY AUDIT

## 22.1 Major Dependencies

| Category | Library | Used By | Purpose |
|----------|---------|---------|---------|
| Framework | NestJS 11 | API | Backend framework |
| Framework | FastAPI | AI Service | Python API framework |
| Framework | Next.js 15.5 | Web apps | React SSR framework |
| Framework | Flutter 3.35 | Mobile apps | Cross-platform mobile |
| ORM | Drizzle ORM | API | TypeScript ORM |
| Database | PostgreSQL 16 + pgvector | All | Primary database |
| Cache | Redis 7 | API | Queues, buffers, rate limits |
| Queue | BullMQ | API | Background job processing |
| Validation | Zod | All TS packages | Runtime schema validation |
| Validation | Pydantic | AI Service | Python schema validation |
| PDF | WeasyPrint | API | HTML→PDF rendering |
| AI SDK | google-generativeai | AI Service | Gemini API client |
| AI SDK | anthropic | AI Service | Anthropic API client |
| HTTP | axios/undici | API | HTTP client |
| Auth | jose | API | JWT handling |
| Crypto | node:crypto | API | AES-256-GCM, HMAC, scrypt |
| Storage | Supabase Storage REST | API | File upload/download |
| SMS | Fast2SMS | API | Worker OTP delivery |
| Email | ZeptoMail | API | Payer email OTP |
| Payments | Razorpay | API | Payment processing |
| Push | FCM (firebase-admin) | API | Push notifications |
| Observability | Langfuse | AI Service | LLM tracing |
| Testing | Vitest 3.x | All TS | Unit/integration testing |
| Testing | pytest | AI Service | Python testing |
| Linting | ESLint 9 | All TS | Code quality |
| Linting | Ruff | AI Service | Python linting |
| Formatting | Prettier | All TS | Code formatting |
| Build | Turborepo | Monorepo | Build orchestration |
| Package | pnpm 11.5.2 | Monorepo | Package management |

---

# PART XXIII — DUPLICATE IMPLEMENTATIONS

## 23.1 Profile Extraction (3 approaches)

| Approach | File | Status | Purpose |
|----------|------|--------|---------|
| Legacy transcript extraction | `profiling/profile_extractor.py` | DORMANT | Full transcript → LLM |
| OIE deterministic parse | `profiling/parse_prompt.py` | ACTIVE | Answer map → LLM with gates |
| Phase C interview overlay | `profiling/prompts.py` | ACTIVE | Conversation → LLM overlay |

## 23.2 Matching (2 systems)

| System | Package | Status | Purpose |
|--------|---------|--------|---------|
| Match Engine V1 | `packages/match-engine` | ACTIVE | Worker feed ranking |
| Reach Engine | `packages/reach-engine` | ACTIVE | Employer candidate ranking |

## 23.3 Resume Building (2 approaches)

| Approach | File | Status | Purpose |
|----------|------|--------|---------|
| LLM-structured | `resume/resume.service.ts` | ACTIVE | Profile → LLM → structured resume |
| Deterministic | `extraction.py` (AI service) | DORMANT | Profile → deterministic resume |

## 23.4 Profiling Lexicon (dual implementation)

| Implementation | Language | File | Purpose |
|----------------|----------|------|---------|
| TypeScript | TS | `packages/profiling-lexicon/src/` | Interview engine |
| Python | Python | `apps/ai-service/app/profiling/lexicon.py` | AI service |

Parity enforced by CI (shared fixture `utterances.jsonl`).

---

# PART XXIV — DORMANT/SILENT MODULES

## 24.1 Complete Dormant Module Register

| Module | Location | Why Silent | Risk if Enabled |
|--------|----------|------------|-----------------|
| `reach-learn` | `packages/reach-learn/` | No training data pipeline | Low (offline only) |
| `match-engine` V1 (employer) | `packages/match-engine` | Feature flag off | Low (deterministic) |
| `profiling/lexicon.py` | AI service | Python mirror of TS | Low (parity tested) |
| `corpus/` | AI service | Human-gated | Medium (model training) |
| `cli/tts_render.py` | AI service | CLI tool | Low |
| `cli/tts_smoke.py` | AI service | CLI tool | Low |
| `cli/stt_smoke.py` | AI service | CLI tool | Low |
| `synthetic/` | AI service | Test data generation | Low |
| `marketing-web` | `apps/marketing-web/` | Static site | None |
| `tests/contract/` | `tests/` | Empty placeholder | Medium (no parity testing) |
| `tests/security/` | `tests/` | Empty placeholder | Medium (no security testing) |

---

# PART XXV — LEGACY MODULES

| Module | Location | Superseded By | Risk |
|--------|----------|---------------|------|
| Legacy transcript extraction | `profiling/profile_extractor.py` | OIE deterministic parse | Low (still functional) |
| `classic`/`modern`/`minimal` resume templates | `resume/templates/` | `bb_trade` (for trade workers) | Low (still functional) |

---

# PART XXVI — EXPERIMENTAL MODULES

| Module | Location | Purpose | Risk |
|--------|----------|---------|------|
| `corpus/assemble.py` | AI service | Consent-gated corpus assembly | Medium (model training) |
| `corpus/finetune_sample.py` | AI service | Small-sample fine-tune harness | High (HUMAN GATE) |
| `eval_canonicalization.py` | AI service | Canonicalization evaluation | Low (offline eval) |
| `persona-harness/` | scripts/ | Persona extraction from docs | Low (dev tooling) |

---

# PART XXVII — DEAD CODE / ORPHAN CANDIDATES

| Candidate | Location | Evidence | Confidence |
|-----------|----------|----------|------------|
| `tests/contract/` | tests/ | Empty directory | Confirmed unused |
| `tests/security/` | tests/ | Empty directory | Confirmed unused |
| `Dockerfile.ai-service` | (if exists) | Not referenced in compose | Possibly unused |
| `start-dev.sh` | scripts/ | Local dev only | Strongly appears unused in prod |

---

# PART XXVIII — INTENDED VS ACTUAL ARCHITECTURE

## 28.1 Intended/Documented Architecture

Per README, CLAUDE.md, and docs:
- Event-first architecture with full audit trail
- Privacy-first with PII never crossing AI boundaries
- AI assists users; deterministic business rules make decisions
- Real AI calls in production
- Real payments via Razorpay
- Real messaging via WhatsApp
- Resume PDF generation via WeasyPrint
- Matching V1 for job recommendations
- Skill canonicalization for skill normalization
- Domain matching for occupation classification
- Capacity enforcement for hiring limits
- PACE supply-widening for thin markets

## 28.2 Actual Code Architecture

Per codebase examination:
- Event-first: **CONFIRMED** — events table + emission at every business action
- Privacy-first: **CONFIRMED** — pseudonymization gateway, encrypted PII, faceless feeds
- Real AI: **NOT CONFIRMED** — all flags default to false (mock mode)
- Real payments: **NOT CONFIRMED** — `PAYMENTS_ENABLE_REAL=false`
- Real messaging: **NOT CONFIRMED** — `MESSAGING_ENABLE_REAL=false`
- Resume rendering: **NOT CONFIRMED** — `RESUME_RENDER_ENABLED=false`
- Matching V1: **PARTIAL** — active for worker feed, flag-gated for employer list
- Skill canonicalization: **NOT CONFIRMED** — `SKILL_CANONICALIZE_ENABLED=false`
- Domain matching: **NOT CONFIRMED** — `DOMAIN_MATCH_ENABLED=false`
- Capacity enforcement: **NOT CONFIRMED** — `CAPACITY_ENFORCEMENT_ENABLED=false`
- PACE: **NOT CONFIRMED** — `PACE_ENABLED=false`

## 28.3 Gap Analysis

| Area | Intended | Actual | Gap | Risk |
|------|----------|--------|-----|------|
| AI processing | Real LLM calls | Mock responses | All AI is mocked | HIGH — no real profiling/resume |
| Payments | Real Razorpay | Mock orders | No real revenue | MEDIUM — feature ready but off |
| Messaging | Real WhatsApp | Log only | No real outreach | MEDIUM — feature ready but off |
| Push notifications | Real FCM | Log only | No real engagement | LOW — feature ready but off |
| Resume rendering | PDF generation | Status pending | No PDFs served | MEDIUM — feature ready but off |
| Skill canonicalization | LLM normalization | Empty results | No skill matching | LOW — feature ready but off |
| Domain matching | ANN classification | Unmatched | No domain matching | LOW — feature ready but off |
| Capacity enforcement | Hiring limits | No enforcement | Unlimited hiring | LOW — feature ready but off |
| PACE | Supply-widening | No waves | No auto-widening | LOW — feature ready but off |
| Contract tests | Zod↔Pydantic parity | Empty | No parity testing | MEDIUM — drift risk |
| Security tests | Cross-service PII | Empty | No security testing | MEDIUM — PII risk |
| Browser E2E | Playwright/Cypress | None | No UI testing | LOW — HTTP-level coverage |

---

# PART XXIX — DATA FLOW MAPS

## 29.1 Worker Profile Flow

```
Input: Worker voice/text during interview
  → Chat messages buffered in Redis
  → Session finalized → flush to Postgres
  → Profile extraction job enqueued
  → AI service processes (parse + Phase C)
  → Profile projected from answer map + AI output
  → worker_profiles + worker_attributes written
  → Match projections rebuilt
  → Events emitted
```

## 29.2 Chat Flow

```
User → Worker App → API → ChatService
  → Redis buffer (zero DB writes)
  → ProfilingOrchestrator decides next question
  → Returns AI reply to user
  → On session end: flush to Postgres
  → Enqueue profile extraction
```

## 29.3 Voice Flow

```
Audio → Worker App → Signed upload URL → Supabase Storage
  → Register voice note → Enqueue transcription
  → Download audio → Chunk → Sarvam STT
  → Redact digits → Translate → Pseudonymize
  → Persist transcript → Emit events
```

## 29.4 Resume Flow

```
Profile → ResumeService.generate()
  → Decrypt name server-side
  → AI generates structured resume
  → Create resume row
  → Enqueue PDF render
  → ResumeRenderProcessor:
    → Decrypt name + phone
    → Fetch photo → Build context
    → WeasyPrint HTML→PDF
    → Upload to Supabase Storage
    → Update resume row
```

## 29.5 Matching Flow (Worker)

```
Worker opens feed → GET /feed
  → Query open postings
  → Overfetch 3x
  → match-engine rankCandidates()
  → interleaveMaxPerCompany()
  → Emit feed.shown_v2 per card
  → Return faceless results
```

## 29.6 Matching Flow (Employer)

```
Employer views candidates → GET /payer/reach/jobs/:id/applicants
  → Query worker pool
  → reach-engine scoreCandidate()
  → rankByScore() with HOT_TOP_RATIO
  → Return faceless ranked rows
```

---

# PART XXX — STATE MACHINES

## 30.1 Worker Lifecycle

```
pending → active (after consent + first profile)
active → suspended (admin action)
suspended → active (admin action)
active → deletion_scheduled (worker request)
deletion_scheduled → deleted (grace period elapsed)
deletion_scheduled → active (worker cancels)
```

## 30.2 Profile Lifecycle

```
draft → extracting (extraction job enqueued)
extracting → extracted (extraction completed with content)
extracting → draft (extraction completed without content)
extracted → confirmed (worker confirms)
```

## 30.3 Chat Session Lifecycle

```
active → ended (worker ends / max turns)
active → abandoned (idle sweep)
```

## 30.4 Job Posting Lifecycle

```
draft → open (published)
open → paused (payer pauses)
paused → open (payer resumes)
open → closed (payer closes)
open → suspended (system cascade)
```

## 30.5 Application Lifecycle

```
applied → (terminal for this version)
skipped → applied (worker flips decision)
```

## 30.6 Unlock Lifecycle

```
requested → granted (credit deducted)
granted → revealed (contact shown)
requested → denied (insufficient credits / consent)
```

## 30.7 AI Job Lifecycle

```
queued → running → completed
queued → running → failed
```

---

# PART XXXI — ERROR/FAILURE PATHS

## 31.1 AI Failures

- **Transient (429, timeout):** BullMQ retry with backoff (5min, 10min)
- **Terminal (budget exceeded, kill switch):** Mark job failed, emit event
- **Service unreachable:** Return safe mock, log warning
- **Malformed output:** Validation failure, mark job failed

## 31.2 Redis Failures

- **Buffer loss:** Interview transcripts lost (no Postgres backup mid-interview)
- **Rate limit failure:** Fail-open (allow request)
- **Queue failure:** Jobs lost (no persistent queue backing)

## 31.3 Database Failures

- **Write failure:** Throw, let BullMQ retry
- **Read failure:** Throw, return error to client
- **RLS violation:** Silent denial (by design)

## 31.4 Storage Failures

- **Upload failure:** Return error to client
- **Download failure:** Degrade gracefully (photo not shown)
- **Delete failure:** Log warning, continue

---

# PART XXXII — BUSINESS RULES EMBEDDED IN CODE

## 32.1 Eligibility Rules

- Workers must accept DPDP consent before profiling
- Workers must have confirmed profile before resume generation
- Workers must have active status before job applications
- Payers must have sufficient credits for contact unlocks
- Payers must have capacity allowance for active job postings

## 32.2 Scoring Rules

- Match engine: Lexicographic tier → skill months → industry months → last worked → last active
- Reach engine: Weighted sum (role 0.35, distance 0.20, skills 0.15, experience 0.15, pay 0.10, availability 0.05)
- HOT_TOP_RATIO: Top 12% of candidates marked as "hot"

## 32.3 Rate Limits

- Worker OTP: 5/hour, 10/day per phone, 10000/day global
- Payer OTP: 2000/day global
- Resume download: 20/IP/hour
- Profile extraction: 6/worker/hour
- Job posting chat: configurable per payer

## 32.4 Pricing Rules

- Default catalog with posting tiers (₹1000/₹2500)
- Boost tiers (₹499/₹999/₹1799)
- Credit packs (₹2000/₹8000/₹32000)
- Capacity tiers (₹5000/₹12000)
- Quota top-ups (₹1000/₹2500)
- Offers and coupons supported but not seeded

---

# PART XXXIII — CURRENT SYSTEM SCORECARD

| Module | Exists | Referenced | Reachable | Active | Verified | Dormant | Experimental | Legacy | Confidence |
|--------|--------|-----------|-----------|--------|----------|---------|--------------|--------|------------|
| API (NestJS) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| AI Service (FastAPI) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Worker App (Flutter) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Payer App (Flutter) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Payer Web (Next.js) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Admin Web (Next.js) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Ops Web (Next.js) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Marketing Web | ✅ | ✅ | ✅ | ✅ | ⚠️ | — | — | — | MEDIUM |
| PostgreSQL schema | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Redis infrastructure | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| BullMQ queues | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Event system | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Auth (worker) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Auth (payer) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Auth (admin) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Profile extraction (OIE) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Profile extraction (legacy) | ✅ | ✅ | ✅ | — | — | ✅ | — | ✅ | HIGH |
| Resume generation (LLM) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Resume generation (deterministic) | ✅ | ✅ | ⚠️ | — | — | ✅ | — | — | MEDIUM |
| Match engine V1 | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Reach engine | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Reach learn | ✅ | ✅ | — | — | — | ✅ | — | — | HIGH |
| Profiling lexicon (TS) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Profiling lexicon (Python) | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Taxonomy | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Pricing engine | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| AI contracts | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Event schema | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Config package | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Validators package | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Types package | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — | HIGH |
| Corpus pipeline | ✅ | ✅ | — | — | — | — | ✅ | — | HIGH |
| Synthetic profiles | ✅ | ✅ | — | — | — | — | ✅ | — | HIGH |
| Contract tests | ✅ | — | — | — | — | — | — | — | HIGH |
| Security tests | ✅ | — | — | — | — | — | — | — | HIGH |

---

# PART XXXIV — CRITICAL ARCHITECTURAL QUESTIONS

1. **What is the actual entry point of Badabhai?**
   `apps/api/src/main.ts` — NestJS bootstrap with StructuredLogger, AllExceptionsFilter, security headers, Razorpay webhook middleware, RequestId middleware.

2. **What are the major services?**
   API (NestJS, port 3001), AI Service (FastAPI, port 8000), Redis (port 6379), PostgreSQL (Supabase), Supabase Storage.

3. **What is the actual production/runtime architecture?**
   Docker Compose on AWS Lightsail. Immutable per-commit image tags. Health-gated deploys. Loopback-only ports (except API 3001 and Payer Web 3333).

4. **What database is the source of truth?**
   PostgreSQL (Supabase) with 72+ tables across 22 domains. Drizzle ORM.

5. **What does Redis actually do?**
   BullMQ queues (12), interview transcript buffers, rate limiting, idempotency guards, OTP storage, session metadata, AI provider cooldowns, spend ledgers.

6. **What queues actually run?**
   12 BullMQ queues: 6 event-driven (profile extraction, voice transcription, resume generate/render, push, referral bonus), 5 repeatable sweeps (account deletion, AI jobs retention, chat abandonment, reach-widen expiry, learn labels), 1 delayed (PACE waves).

7. **What AI providers are actually being called?**
   Gemini (primary, via REST), Anthropic (fallback, via SDK), Sarvam (STT/TTS/translate, via REST).

8. **Which AI calls are mocked?**
   ALL when `AI_ENABLE_REAL_CALLS=false` (default). This includes: profile extraction, profile parse, interview turn, resume generation, skill embedding, skill canonicalization.

9. **Which profile extraction method is active?**
   OIE deterministic parse (Approach 2) + Phase C interview overlay (Approach 3). Legacy transcript extraction (Approach 1) is dormant.

10. **Which resume generation method is active?**
    LLM-structured generation (Approach 1) + WeasyPrint HTML→PDF rendering. Deterministic builder (Approach 2) is dormant.

11. **Which matching method is active?**
    Match Engine V1 (lexicographic) for worker feed. Reach Engine (weighted scoring) for employer candidate list.

12. **Are there multiple competing implementations?**
    Yes: 3 profile extraction paths, 2 matching systems, 2 resume builders, 2 profiling lexicon implementations (TS + Python).

13. **Which modules are dormant?**
    reach-learn, skill canonicalization, domain matching, capacity enforcement, PACE, real payments, real messaging, real push, resume rendering, corpus pipeline, synthetic profiles.

14. **Which modules appear incomplete?**
    tests/contract/ (empty), tests/security/ (empty), job posting chat LLM rephrase (deterministic only, no LLM yet).

15. **Which modules are legacy?**
    Legacy transcript extraction (superseded by OIE).

16. **Which modules are experimental?**
    corpus/ (model training, human-gated), synthetic/ (test data generation).

17. **Which APIs are actively used?**
    Worker auth, chat, profile extraction, resume generation, job feed, applications, payer auth, job postings, unlocks, credits, admin entities/events.

18. **Which APIs appear orphaned?**
    None clearly orphaned — all registered routes have controllers and appear reachable.

19. **Which DB tables are actively used?**
    All 72+ tables appear actively used by their respective modules.

20. **Which DB tables appear orphaned?**
    None identified — all tables have readers and writers.

21. **What are the major technical risks?**
    Mock AI in production (no real profiling), Redis buffer loss (interview transcripts), feature flag sprawl, no contract/security tests, no browser E2E.

22. **What are the major architectural inconsistencies?**
    Dual extraction paths, dual matching systems, 3 mobile/web frameworks, Python + TypeScript lexicon implementations.

23. **Where can data be lost?**
    Redis buffer (interview transcripts before flush), Supabase Storage (files if deletion sweep runs before backup).

24. **Where can state become inconsistent?**
    Profile extraction race conditions (multiple triggers), resume render vs. photo delete, concurrent session reattachment.

25. **What areas are difficult to understand or maintain?**
    Profile extraction processor (1900+ lines), chat service (1000+ lines), profiling orchestrator (1000+ lines).

26. **What parts of the system have the highest complexity?**
    Profile extraction (3 paths, 6 parse gates, Phase C overlay), chat (Redis buffering, CAS, flush), pricing (config-driven with offers/coupons).

27. **What parts are most fragile?**
    Redis buffer (volatile), WeasyPrint rendering (external process), AI provider fallback chain.

28. **What parts have multiple competing implementations?**
    Profile extraction (3), matching (2), resume building (2), profiling lexicon (2 languages).

29. **What should a future coding agent understand before modifying anything?**
    Check active vs. dormant paths, feature flags, mock/real mode, PII boundaries, event emission, idempotency.

30. **What assumptions would be dangerous for a new developer/AI agent to make?**
    AI is real, resume rendering is on, matching V1 is used everywhere, Redis is durable, events are analytics, PII is safe in logs, dormant modules are dead, the ops web is user-facing, Flutter apps share code, the AI service has database access.

---

# PART XXXV — AI CODING AGENT CONTEXT

## SYSTEM IDENTITY

Badabhai is an AI-first hiring platform for blue/grey-collar Indian workers. Workers are profiled through a deterministic Hinglish interview engine, profiles are extracted via AI, resumes are generated as PDFs, and workers are matched with jobs. Employers pay to unlock worker contacts.

## REPOSITORY STRUCTURE

- `apps/api/` — NestJS backend (primary, port 3001)
- `apps/ai-service/` — FastAPI Python AI service (port 8000)
- `apps/web/` — Next.js ops console (port 3000)
- `apps/payer-web/` — Next.js payer portal (port 3002)
- `apps/admin-web/` — Next.js admin portal (port 3003)
- `apps/worker-app/` — Flutter worker mobile
- `apps/payer-app/` — Flutter payer mobile
- `packages/` — 12 shared packages (db, config, types, validators, match-engine, reach-engine, profiling-lexicon, taxonomy, event-schema, ai-contracts, pricing, reach-learn)

## RUNTIME SERVICES

1. **API** (NestJS, port 3001) — All business logic, DB access, queue management
2. **AI Service** (FastAPI, port 8000) — LLM calls, profiling, resume generation, STT
3. **Redis** (port 6379) — Queues, session buffers, rate limiting
4. **PostgreSQL** (Supabase) — All persistent data (72+ tables)
5. **Supabase Storage** — Files (resumes, photos, voice notes)

## DATA MODEL — KEY RELATIONSHIPS

```
Worker → WorkerProfile → WorkerAttributes (319+ rows)
Worker → ChatSession → ChatMessages → PackAnswers
Worker → VoiceNotes → Transcripts
Worker → Resumes → ResumeVersions
Worker → Applications → JobPostings
Worker → ReferralAttributions → ReferralBonuses
Payer → JobPostings → Applications
Payer → Unlocks → Credits
Payer → OrgMembers → OrgInvites
```

## AI MAP

| Task | Model | Provider | Active |
|------|-------|----------|--------|
| Profile extraction | gemini-2.5-flash | Gemini | Mock by default |
| Profile parse | gemini-2.5-flash | Gemini | Mock by default |
| Interview turn | gemini-2.5-pro | Gemini | Mock by default |
| Resume generation | gemini-2.5-flash | Gemini | Mock by default |
| Skill embedding | gemini embedding | Gemini | Mock by default |
| Skill canonicalization | gemini-2.5-flash | Gemini | Mock by default |
| Voice transcription | saarika:v2.5 | Sarvam | Active |
| Voice translation | mayura:v1 | Sarvam | Active |

## PROFILE EXTRACTION

- **Active:** OIE deterministic parse + Phase C overlay
- **Dormant:** Legacy transcript extraction
- **Flow:** Chat interview → answer map → BullMQ job → AI parse → 6 gates → Phase C overlay → project profile → write DB

## RESUME GENERATION

- **Active:** LLM-structured + WeasyPrint HTML→PDF
- **Dormant:** Deterministic builder
- **Templates:** bb_trade (v1), classic/modern/minimal/fallback (v3)
- **Gate:** `RESUME_RENDER_ENABLED=false` by default

## MATCHING

- **Worker feed:** Match Engine V1 (lexicographic ranking)
- **Employer list:** Reach Engine (weighted scoring)
- **Calibration:** Reach Learn (dormant)

## CHAT

- Redis-buffered transcript (zero DB writes mid-interview)
- Flushes ONCE at session end (transactional)
- CAS defense against race conditions
- 6-hour abandonment sweep

## VOICE

- AAC-LC recording → Supabase Storage → Sarvam STT → digit redaction → translate → pseudonymize
- Dormant when `VOICE_NOTES_BUCKET` unset

## QUEUES

12 BullMQ queues: 6 event-driven, 5 sweeps, 1 delayed

## REDIS

Interview buffers, rate limits, idempotency, OTP storage, session metadata, AI cooldowns, spend ledgers

## STORAGE

6 buckets: worker-conversations, worker-resumes, interview-kits, voice-notes (dormant), worker-photos (dormant), feedback-attachments (dormant)

## FEATURE FLAGS

21 flags, most default to false. Only `CHAT_LLM_INTERVIEW_ENABLED=true` is active by default.

## CURRENT ACTIVE FLOWS

1. Worker onboarding (phone OTP → PIN → consent → chat → profile → resume)
2. Job matching (feed → apply/skip)
3. Employer hiring (post → rank → unlock)
4. Agency referral (invite → join → track)

## DORMANT FLOWS

Real payments, real messaging, real push, resume rendering, skill canonicalization, domain matching, capacity enforcement, PACE, reach-learn calibration.

## KNOWN ISSUES

1. All AI is mocked by default
2. Redis buffer loss risk for interview transcripts
3. No contract tests (Zod ↔ Pydantic parity)
4. No security tests (cross-service PII)
5. No browser E2E
6. Feature flag sprawl (21 flags)
7. 3 profile extraction paths (complexity)

## IMPORTANT RISKS

1. Enabling `AI_ENABLE_REAL_CALLS` without testing could expose PII to LLMs
2. Redis crash loses interview transcripts
3. WeasyPrint subprocess could leak PII
4. Feature flag misconfiguration could enable unintended behavior

## DO NOT ASSUME

1. AI is real (it's mocked by default)
2. Resume rendering is on (it's off by default)
3. Matching V1 is used everywhere (only worker feed)
4. Redis is durable (it's AOF but not backed up like Postgres)
5. Events are analytics (they're the audit trail)
6. PII is safe in logs (it's aggressively pseudonymized)
7. Dormant modules are dead (they're feature-flagged)
8. The ops web is user-facing (it's internal-only)
9. Flutter apps share code (separate codebases)
10. The AI service has database access (it's DB-free)

## SAFE CHANGE RULES

1. Before modifying profile extraction: Check OIE vs legacy path
2. Before modifying resume generation: Check `RESUME_RENDER_ENABLED`
3. Before modifying matching: Check worker feed vs employer list
4. Before modifying auth: There are 4 auth paths
5. Before modifying AI calls: Check mock/real mode
6. Before modifying Redis keys: Check TTLs and consumers
7. Before modifying DB schema: Run `pnpm db:generate`
8. Before adding events: Register in event-schema package
9. Before adding feature flags: Add to config with fail-closed defaults
10. Before modifying prompts: Check TS + Python parity

---

# PART XXXVI — QUESTIONS/UNKNOWNS REQUIRING HUMAN CONFIRMATION

1. Is `AI_ENABLE_REAL_CALLS` enabled in production? (Cannot determine from code alone)
2. Is `RESUME_RENDER_ENABLED` enabled in production?
3. Are real payments active in production?
4. Is the voice notes bucket configured in production?
5. Is the worker photos bucket configured in production?
6. What is the actual production Lightsail configuration?
7. Are there any manual interventions not captured in code?
8. What is the actual cost of AI calls in production?
9. How many workers are actively using the platform?
10. What is the actual interview completion rate?

---

**END OF REPORT**
