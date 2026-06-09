# Phase 1 — Worker Profiling Sprint Plan

Scope: **Worker Profiling + Profile Generation only.** Out of scope: employer
posting, unlock, payments, payouts, boosts, Reach Engine ranking, advanced
matching, production legal flows, real OTP/STT/LLM/payment providers.

Status legend: ✅ done in this foundation · 🔜 next · ⏳ later

---

## Sprint 0 — Foundation

- ✅ Monorepo (pnpm + Turborepo), TS strict, ESLint/Prettier
- ✅ Local dev: docker-compose (Postgres + Redis + Adminer), `.env.example`
- ✅ CI: lint + typecheck + test + build (`.github/workflows/ci.yml`)
- ✅ Env templates + typed config (`@badabhai/config`, server/public split)

## Sprint 1 — Contracts, Identity, Consent

- ✅ Event schema (`@badabhai/event-schema`) — envelope, registry, 22 events
- ✅ DB schema + migration (`@badabhai/db`) — 10 tables
- ✅ Worker identity: mock OTP request/verify → `worker.created`/`otp_verified`
- ✅ Consent capture → `consent.accepted`
- 🔜 Real OTP provider; worker auth → DB identity mapping for RLS

## Sprint 2 — Profiling, AI Gateway, Extraction, Resume

- ✅ Chat profiling backend (`/chat/session`, `/chat/message`) + events
- ✅ AI gateway (FastAPI): pseudonymization (fail-closed) before any LLM
- ✅ Profile extraction (`/profile/extract`) + confirm — **now async via BullMQ**
  (`202` + poll `GET /ai-jobs/:id`); `profile.extraction_failed` event ([ADR-0002](../decisions/0002-async-extraction-and-action-recording.md))
- ✅ Resume generation (`/resume/generate`, placeholder, name-less to AI)
- ✅ Voice-note upload placeholder (duration ≤ 120s) + event
- ✅ Action recording (`POST /actions`, `/actions/batch`) → `action.recorded`
  (generic, events-only, behavioural stream for the future Learn layer)
- 🔜 Move **transcription** to BullMQ jobs (extraction done; STT contract pending)
- 🔜 Real Sarvam STT; NER/LLM-assisted PII detection; enable real LLM in staging

## Sprint 3 — Apps

- ✅ Flutter worker app scaffold (Splash → … → ResumePreview)
- ✅ Next.js ops console shell (workers / events / ai-jobs)
- 🔜 Wire worker app `ApiClient` to the API (real HTTP + models)
- 🔜 Wire ops console pages to the API (read-only)

---

## Phase 1 exit criteria

- A worker can: log in (mock OTP) → consent → chat → get an extracted, confirmed
  profile → get a generated resume, with **every step emitting a validated event**
  and **no PII ever reaching an LLM**.
- Ops can view workers / events / AI jobs (read-only).

## Definition of "later" (Phase 2+)

Reach Engine (reach → rank → pace → protect → learn), employer posting + unlock,
payments + payouts, boosts, advanced matching, production legal/DPDP flows,
finalized RLS, real provider integrations.
