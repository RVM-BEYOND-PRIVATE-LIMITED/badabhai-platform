# 01 — System Boundary

Evidence-based inventory of every application, service, package, and infra component in
badabhai-platform, its purpose, entry point, dependencies, consumers, production status, and
ownership. Compiled from direct repository inspection (package manifests, Dockerfiles,
docker-compose files, `.github/workflows/*.yml`, entry-point source).

Ownership follows CLAUDE.md §5 (Backend Platform: APIs, Database, AI, Infrastructure —
Prakash, Divyanshu; Frontend Platform: Mobile, Web, UI, UX — Rishi), cross-referenced against
this repo's `.claude/agents/` domain-owner map where CLAUDE.md doesn't split a package
explicitly.

## Applications

### apps/api — the backend
| | |
|---|---|
| Purpose | The only backend service that owns business logic — NestJS monolith serving worker/payer/admin/agency HTTP APIs, event emission, and BullMQ queue processors (in-process). Sole caller of `apps/ai-service`. |
| Entry point | `apps/api/src/main.ts` (`nest start` / `node dist/main.js`, port 3001) |
| Key dependencies | `packages/db`, `packages/event-schema`, `packages/ai-contracts`, `packages/match-engine`, `packages/pricing`, `packages/taxonomy`, `packages/validators`, `packages/types`, `packages/config`; Redis; Fast2SMS, ZeptoMail, Razorpay, `apps/ai-service` over HTTP |
| Consumers | apps/web, apps/payer-web, apps/admin-web, apps/worker-app, apps/payer-app — all five frontends, and only these |
| Production status | **Actively deployed.** `apps/api/Dockerfile` exists; built/pushed to `ghcr.io/.../badabhai-api` on `main` push; deployed to AWS Lightsail via `docker compose -f docker-compose.yml -f docker-compose.staging.yml --profile api`. Environment is named "staging" in CI but is the persistent always-on box. |
| Ownership | Backend Platform |

### apps/ai-service — the AI gateway
| | |
|---|---|
| Purpose | FastAPI pseudonymization gateway + LLM/STT/TTS orchestration (profiling parse/extract, resume generation, skill embeddings, job-posting chat). Never called by frontends directly; never makes business decisions — returns extracted/generated content apps/api validates and applies. |
| Entry point | `apps/ai-service/app/main.py` (`uvicorn app.main:app`, port 8000); routers under `app/routers/*.py` (health, profile, profiling, resume, skills, embeddings, voice, job_posting, privacy, growth) |
| Key dependencies | Gemini Flash (primary LLM), Anthropic/Claude (fallback), Sarvam AI (STT/TTS/translate), Langfuse (optional tracing), `packages/profiling-lexicon` (mirrored byte-identically into the service's own tree since the Docker build context can't reach the monorepo), `AI_INTERNAL_TOKEN` service-bearer auth on every route except `/health` |
| Consumers | apps/api exclusively, server-to-server |
| Production status | **Actively deployed.** `apps/ai-service/Dockerfile` exists; image built and pushed to `ghcr.io/.../badabhai-ai-service`; deployed on the same Lightsail box, health-gated to start *before* apps/api. |
| Ownership | Backend Platform (repo-ownership); AI Systems Engineer owns the Python contracts/prompts within it under the engineering-org agent model |

### apps/web — internal ops console
| | |
|---|---|
| Purpose | Next.js internal read/ops surface over events, workers, jobs, reach, pace, pricing, agency-KYC, applicants — for internal staff only. |
| Entry point | Next.js App Router, `next dev/start -p 3000` |
| Key dependencies | apps/api (HTTP only) |
| Consumers | Internal staff browsers |
| Production status | **UNCLEAR — flagged for verification.** No Dockerfile, no docker-compose service entry, no CI build-and-push job, no deploy job of any kind references this app anywhere in `.github/workflows/`. It builds/typechecks/tests as part of the generic Turborepo `pnpm build`/`typecheck`/`test` CI step, so it compiles — but there is no in-repo evidence of where it is actually hosted, if at all. |
| Ownership | Frontend Platform |

### apps/payer-web — external payer/agency portal
| | |
|---|---|
| Purpose | External self-serve employer/agency portal: job postings, applicants, credits/pricing, team management, agency dashboard/QR/referrals. Own `package.json` description flags it "ADR-0019 Phase 1: MOCK + staging-only." |
| Entry point | Next.js App Router, `next dev/start -p 3002` |
| Key dependencies | apps/api (HTTP only), `packages/taxonomy` types |
| Consumers | Employer/agency browsers |
| Production status | **Same gap as apps/web** — no Dockerfile, no compose entry, no deploy job. Has a dedicated CI lint gate (`pnpm lint:oxlint` against its `src`) and a `scripts/verify-assetlinks-release.mjs` implying an Android App Links / TWA release path exists, but no workflow invokes it. Hosting destination is not evidenced in-repo. |
| Ownership | Frontend Platform |

### apps/admin-web — internal admin portal
| | |
|---|---|
| Purpose | Internal admin presentation layer (ADR-0025/0038) over admins, agencies, companies, credits, events, jobs, roles, system, transactions, workers. |
| Entry point | Next.js App Router, `next dev/start -p 3003` |
| Key dependencies | apps/api (HTTP only) |
| Consumers | Internal admin staff |
| Production status | **Same gap** — no Dockerfile, no compose entry, no deploy job; built/tested only via the generic Turborepo CI step. |
| Ownership | Frontend Platform |

### apps/worker-app — worker mobile (Flutter)
| | |
|---|---|
| Purpose | The primary product surface per CLAUDE.md §1: chat/voice profiling interview, resume, applications, referrals for blue/grey-collar workers. |
| Entry point | Flutter `lib/main.dart`; DI locator at `lib/core/di/locator.dart` |
| Key dependencies | apps/api (HTTP only) — no direct DB or ai-service access, by design (mobile never holds server authority) |
| Consumers | Android/iOS worker users |
| Production status | **CI-gated but not built/shipped from this repo.** `.github/workflows/worker-app.yml` is a blocking reusable gate (`flutter analyze` + `flutter test`, pinned Flutter 3.35.7/Dart 3.9.2) — analyze/test only, no `flutter build apk/appbundle`, no store-upload step anywhere in the workflows. Store distribution is either manual/out-of-repo or not yet built. |
| Ownership | Frontend Platform |

### apps/payer-app — payer/agent mobile (Flutter)
| | |
|---|---|
| Purpose | Mirrors apps/payer-web for payers/agencies/agents. Payment workflows are explicitly excluded per CLAUDE.md §12 — payment stays web-only. |
| Entry point | Flutter, structure analogous to worker-app |
| Key dependencies | apps/api (HTTP only) |
| Consumers | Android/iOS payer/agent users |
| Production status | Same posture as worker-app — `.github/workflows/payer-app.yml` is analyze/test only, same Flutter pin, no build/store-upload step. |
| Ownership | Frontend Platform |

## Shared packages

| Package | Purpose | Consumers | Status | Owner |
|---|---|---|---|---|
| `packages/db` | Single source of truth for the Postgres schema (Drizzle), 74+ migrations, seed/verify/retag CLIs | apps/api (runtime); `supabase-checks.yml` (drift gate); e2e CI (fresh-DB chain) | Actively used. **Migrations are NOT auto-applied on deploy** — held pending human sign-off (CD-2) | Backend Platform |
| `packages/event-schema` | Canonical event envelope/registry/Zod payloads — the audit-trail invariant (CLAUDE.md §3 Event First) | apps/api (writer); apps/web/admin-web (read, ops event stream) | Actively used, versioned, never mutated | Chief Software Architect (contract owner) |
| `packages/ai-contracts` | Zod half of the AI I/O contract, mirrored as Pydantic in `apps/ai-service/app/contracts.py` | apps/api | Actively used; parity with the Python mirror is a blocking gate | Chief Software Architect (Zod half) / AI Systems (Pydantic mirror) |
| `packages/match-engine` | Matching V1 (CEO-ratified 2026-07-30) — pure, deterministic match core, no weights/model/I-O | apps/api match/rank services, DB-backed parity tests | **Actively deployed and live-ranking**, not dormant | Backend Platform |
| `packages/pricing` | ADR-0013 deterministic, fail-closed `resolvePrice`, pure/PII-free | apps/api pricing service, payer-pricing controller | Actively used | Backend Platform |
| `packages/reach-engine` | Deterministic Reach Engine RANK core (score + order workers for a job) | apps/api reach services | Actively used | Backend Platform |
| `packages/reach-learn` | ADR-0017 offline learn-to-rank layer calibrating RANK dials from PII-free events | **None found** — grep across the repo finds zero imports outside the package's own files | **Dormant — deliberately, per its own "offline/shadow only, no live ranking influence" description, not an integration gap** | Backend Platform |
| `packages/taxonomy` | Canonical CNC/VMC manufacturing taxonomy (industries/domains/roles/skills/machines) | apps/api (match, job-postings, resume, reach), packages/db seed/retag scripts, packages/match-engine | Actively used | Backend Platform |
| `packages/types` | Shared, dependency-free domain types/enums | Broadly imported (foundational/leaf package) | Actively used | Chief Software Architect — **confirm in ownership-map.md; may be a path with no explicit owner today** |
| `packages/validators` | Reusable Zod validators (phone, uuid, language, voice duration, safe text, consent) | apps/api DTOs, likely packages/ai-contracts | Actively used | Backend Platform |
| `packages/config` | Typed environment validation, split server (secret) / public (browser-safe); gates every real-provider posture (`AI_ENABLE_REAL_CALLS`, `PAYMENTS_ENABLE_REAL`, `MESSAGING_ENABLE_REAL`, `SMS_PROVIDER`, `EMAIL_PROVIDER`) fail-closed | apps/api boot | Actively used — the repo's central invariant-enforcement point; subject of this branch's own #813/#814/#819 fixes | Backend Platform (consumed only by apps/api) — **straddles Chief Architect's standards ownership; recommend confirming split** |
| `packages/profiling-lexicon` | Shared Hinglish occupational lexicon (JSON-first) read by both apps/api (TS) and apps/ai-service (Python mirror) | apps/api, apps/ai-service | Actively used; parity enforced by `test_lexicon_parity.py`, CI path-filtered | Backend Platform |

## Infrastructure

| Component | Purpose | Status | Owner |
|---|---|---|---|
| `infra/docker` | Postgres init scripts + a local proxy-harness for dev parity with staging's `proxy` compose service | Dev-only tooling, not itself deployed | Backend Platform |
| `infra/supabase` | Migration plan, RLS plan, storage-bucket plan/SQL, local-dev notes — reference material; the real schema lives in `packages/db/migrations` | Reference docs | Backend Platform |
| `infra/redis` | Documents Redis's role — cache + BullMQ backing | **Actively deployed**, box-local on the Lightsail staging host (explicit owner decision, not Supabase-managed) | Backend Platform |
| `infra/monitoring` | README describing structured logging + a "reserved" Langfuse integration | **Stale doc** — the README says "no live integration in Phase 1," but `apps/ai-service/app/config.py` and `main.py` show real, key-gated Langfuse tracing code already wired. Functionally still dormant (no evidence the keys are set in staging) but the code path is real, not merely reserved. Flagged as a documentation-hygiene item. | Backend Platform / DevOps |

## Data & messaging

| Component | Purpose | Consumers | Status |
|---|---|---|---|
| Postgres (Supabase-managed) | System of record for all worker/payer/admin/event/match/pricing/taxonomy data; pgvector extension for embeddings; RLS on `anon`/`authenticated`/`service_role` | apps/api exclusively | Actively deployed; migrations require manual human application |
| Redis | Cache + BullMQ queue backend | apps/api | Actively deployed, box-local |
| BullMQ queue | Async job processing: profile extraction, resume render, voice transcription, push notifications, referral bonuses, pace, account-deletion sweep, ai-jobs retention sweep | Internal to apps/api only | Actively deployed. **Processors run in-process inside the same Nest app that serves HTTP** — `queue.module.ts` states this explicitly as a Phase 1 choice; there is no independently-deployed worker process today. |

## External providers

| Provider | Role | Gate | Notes |
|---|---|---|---|
| Fast2SMS | Worker OTP SMS | Always real — no mock/dev-echo path exists | Fail-closed by design, not a gap |
| ZeptoMail | Payer OTP / transactional email | `EMAIL_PROVIDER=zeptomail` default; requires API token + mail agent + from-address | Subject of this branch's own #813/#814/#819 fixes |
| Gemini Flash | Primary LLM | `GEMINI_FLASH_API_KEY` is the master gate, mirrored by `AI_ENABLE_REAL_CALLS` | |
| Anthropic (Claude) | Secondary/fallback LLM | `ANTHROPIC_API_KEY` optional | |
| Sarvam AI | STT (`saarika:v2.5`), translate (`mayura:v1`), TTS (`bulbul:v2`) for voice profiling | Cost-tracked estimates pending first real invoice | |
| Razorpay | Payment webhook (unlocks/credits) | `PAYMENTS_ENABLE_REAL` defaults **false** — "MOCK-ONLY... in alpha there is no real money movement" | |
| Langfuse | LLM tracing | Key-gated, dormant unless both keys set | No evidence keys are set in staging secrets |

## Key gaps surfaced by this inventory

1. **apps/web, apps/payer-web, apps/admin-web have no evidenced deployment path** — no
   Dockerfile, no compose service, no CI deploy job. They compile via the generic Turborepo CI
   check, but this audit found no in-repo evidence of where (or whether) they are actually
   hosted. This needs a direct answer from Frontend Platform / DevOps, not a guess.
2. **`packages/reach-learn` has zero consumers** — confirmed dormant by design (offline/shadow
   layer), not a bug. Recorded here so Batch 2's dependency audit doesn't independently
   "rediscover" this as a false-positive dead-code alarm.
3. **`infra/monitoring/README.md` is stale** relative to the actual (key-gated, dormant)
   Langfuse wiring already present in `apps/ai-service`.
4. **BullMQ processors are in-process**, not a separately deployed worker — anyone assuming a
   "workers" service exists in this platform (as the source audit template does) will not find
   one; queue consumers live inside apps/api.
