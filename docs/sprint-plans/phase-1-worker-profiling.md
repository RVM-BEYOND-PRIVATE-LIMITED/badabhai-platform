# Phase 1 — Worker Profiling Sprint Plan

Scope: **Worker Profiling + Profile Generation only.** Out of scope: employer
posting, unlock, payments, payouts, boosts, Reach Engine ranking, advanced
matching, production legal flows, real OTP/STT/LLM/payment providers.

Status legend: ✅ done in this foundation · 🔜 next · ⏳ later · 🔒 gated (Phase-2 alpha gate)

---

## Sprint 0 — Foundation

- ✅ Monorepo (pnpm + Turborepo), TS strict, ESLint/Prettier
- ✅ Local dev: docker-compose (Postgres + Redis + Adminer), `.env.example`
- ✅ CI: lint + typecheck + test + build (`.github/workflows/ci.yml`)
- ✅ Env templates + typed config (`@badabhai/config`, server/public split)

## Sprint 1 — Contracts, Identity, Consent

- ✅ Event schema (`@badabhai/event-schema`) — envelope, registry, **105 event types** registered
- ✅ DB schema + migration (`@badabhai/db`) — **43 tables** (was 10 at ADR-0001)
- ✅ Worker identity: **real OTP via Fast2SMS DLT** → `worker.created`/`otp_verified`  
  (`SMS_PROVIDER=fast2sms` is the **only** value; `console` fails Zod boot parse — no mock path exists)
- ✅ Consent capture → `consent.accepted` (append-only, versioned, revocable)

## Sprint 2 — Profiling, AI Gateway, Extraction, Resume

- ✅ Chat profiling backend (`/chat/session`, `/chat/message`) + events
- ✅ AI gateway (FastAPI): pseudonymization (fail-closed) before any LLM
- ✅ Profile extraction (`/profile/extract`) + confirm — **async via BullMQ**
  (`202` + poll `GET /ai-jobs/:id`); `profile.extraction_failed` event (ADR-0002)
- ✅ Resume generation (`/resume/generate`, placeholder, name-less to AI)
- ✅ Per-trade content (deterministic, no-LLM): **resume + interview-kit content now
  cover all 15 alpha trades** (resume = 15/15; interview-kit = 15/15 after drafting
  the 9 missing kits, 2026-06-15). ⚠️ **Content is DRAFTED, PENDING RVM
  ratification** — a human content gate; not "final/approved" until RVM ticks the
  per-role checklist. The reviewable sign-off artifact (full per-trade content + the
  PASS/CHANGES checklist for the 9 drafted trades) is staged for RVM in the
  [ratification packet](../registers/trade-content-ratification-packet.md); tracked in
  [trade-content-ratification.md](../registers/trade-content-ratification.md) (TD24a).
  **Ratification unlocks:** PASS makes that trade's content production-ready and lets the
  alpha device verification exercise all 9 trades
- ✅ Voice-note upload placeholder (duration ≤ 120s) + event
- ✅ Action recording (`POST /actions`, `/actions/batch`) → `action.recorded`
  (generic, events-only, behavioural stream for the future Learn layer)
- 🔒 Move **transcription** to BullMQ jobs (extraction done; STT contract pending — ADR-0009, TD6)
- 🔒 Real Sarvam STT; NER/LLM-assisted PII detection; enable real LLM in staging

## Sprint 3 — Apps

- ✅ Flutter worker app scaffold (Splash → … → ResumePreview)
- ✅ Next.js ops console shell (workers / events / ai-jobs)
- 🔜 Wire worker app `ApiClient` to the API (real HTTP + models)
- 🔜 Wire ops console pages to the API (read-only)
- 🔒 **Alpha device capstone — NO-GO as of 2026-06-15** (deferred, fixing gaps first):
  app covers login→consent→chat→profile→resume-text only. Gaps before the device
  run: resume **PDF download** (signed URL), **voice** flow (placeholder today),
  **interview-kit** screen. **Swipe** is out of Phase-1 (Reach Engine). Tracked as
  **TD29**; plan + go/no-go in [docs/qa/phase-1-alpha-device-capstone.md](../qa/phase-1-alpha-device-capstone.md).
- ✅ **Alpha swipe-to-apply surface (per [ADR-0009](../decisions/0009-alpha-swipe-to-apply-seeded-jobs.md), 2026-06-15)** — a *scoped alpha activation*, **not** the Phase-2
  Reach feed: a seeded `jobs` + `applications` producer (additive, PII-free, no event
  payload version bump), three consent-gated worker routes (feed / apply / skip) emitting
  the existing ADR-0006 events, two PII-free ops applicant reads, a reusable `ConsentGuard`,
  and a worker swipe screen. **No ranking** (score=0, rank=seed order), **no** employer
  console / unlock / payments — those Phase-2 surfaces stay out (the "Swipe is out of
  Phase-1 / Reach Engine" line above still holds for the *Reach feed*). Closes the capstone
  "swipe" gap **in code**; device-verification still pending (Jun-25). Two security reviews
  PASS. Migration not yet applied to a shared DB (needs sign-off, CLAUDE.md §7).

---

## Phase 1 Exit Criteria

- A worker can: log in (**real OTP via Fast2SMS DLT** — no console/mock path) → consent → chat → get an extracted, confirmed
  profile → get a generated resume, with **every step emitting a validated event**
  and **no PII ever reaching an LLM**.
- Ops can view workers / events / AI jobs (read-only).

---

## Definition of "later" (Phase 2+)

Reach Engine (reach → rank → pace → protect → learn), employer posting + unlock,
payments + payouts, boosts, advanced matching, production legal/DPDP flows,
finalized RLS (least-privilege app role), real provider integrations.

---

## Additive Phase-2 Alpha Gates (Landed Behind Launch Gates, Not Phase-1 Scope Changes)

> **Note:** The following streams have landed **additively** since the sprint plan was written, each by its own ADR and behind launch gates. They do **not** relax the Phase-1 invariants or scope. Real-money / real-provider / per-payer-auth / production-legal portions remain deferred (CLAUDE.md §8).

| Stream | ADR | Status | Key Gates |
|--------|-----|--------|-----------|
| Contact Unlock + Reveal (Stream A) | [ADR-0010](../decisions/0010-contact-unlock-and-reveal.md) | ✅ Built + verified 2026-06-17 | Mock credits, in-app relay, `InternalServiceGuard`; LC-1..LC-7 open (TD33/TD34/TD35/TD41/R16–R21) |
| Reach feed serving (View A + B) | [ADR-0011](../decisions/0011-reach-feed-serving.md) / [ADR-0015](../decisions/0015-reach-feed-on-real-jobs.md) | ✅ Built | Deterministic RANK core unchanged; TD36 deferrals |
| Ops job postings (banded, stored-only) | [ADR-0012](../decisions/0012-ops-job-postings-banded-stored-only.md) | ✅ Built | Distinct from swipe `jobs`; TD37 deferrals |
| Monetization + config-driven pricing | [ADR-0013](../decisions/0013-monetization-and-config-driven-pricing-engine.md) | ✅ Built | Mock payments; boost ranking deferred (TD42 guarded) |
| Per-payer hiring capacity | [ADR-0016](../decisions/0016-payer-hiring-capacity.md) | ✅ Built (inert) | `CAPACITY_ENFORCEMENT_ENABLED=false`; mock payments; advisory `payer_id` (TD43) |
| Self-serve payer/agency portal | [ADR-0019](../decisions/0019-self-serve-payer-portal.md) | ✅ Phase 1 built (mock, staging) | `PayerAuthGuard` built (LC-1 satisfied for payer surface); real payments + RLS + open GA deferred |
| WhatsApp invite funnel | [ADR-0020](../decisions/0020-whatsapp-invite-funnel-and-reengagement.md) | ✅ Built (mock) | `MESSAGING_ENABLE_REAL=false` |
| PACE supply-widening + ops alert | [ADR-0021](../decisions/0021-pace-supply-widening-and-ops-alert.md) | ✅ Built (inert) | `PACE_ENABLED=false`; adjacent-trade gated (Q13/TD45) |
| Agency supply portal (demand slice) | [ADR-0022](../decisions/0022-agency-supply-portal.md) | ✅ Backend + frontend wired (mock) | KYC/payouts/matching deferred; `AGENCY_PAYOUTS_ENABLED=false` (Amdt 2) |
| LEARN layer (offline LTR) | [ADR-0017](../decisions/0017-learn-layer-offline-rank-calibration.md) | ✅ Built (offline) | Live promotion = separate human gate; `@badabhai/reach-learn` offline-only |
| Model-training corpus | [ADR-0018](../decisions/0018-model-training-corpus-and-finetune.md) | ✅ Offline core built | GPU spend + real NER + live serving = human-gated |
| Production worker auth (PIN + tiered sessions) | [ADR-0026](../decisions/0026-production-worker-auth-pin-and-tiered-sessions.md) | ✅ Phases 0-5 merged | Deferred hardening → TD55 |
| Worker-visible job fields (PII boundary) | [ADR-0024](../decisions/0024-worker-visible-job-fields-pii.md) | ✅ Built | Employer identity hidden; banded pay shown |
| Account deletion (7-day grace) | [ADR-0031](../decisions/0031-account-deletion-grace-window.md) | ✅ Built | Makes "7 din / cancel anytime" copy true |
| Skills taxonomy + canonicalization | [ADR-0030](../decisions/0030-embedding-skill-canonicalization.md) | ✅ TAX-1..4 merged | TAX-5..9 pinned; fork-B seam for unresolved phrases |
| Push notifications (FCM) | [ADR-0034](../decisions/0034-worker-push-notifications.md) | ✅ Built (inert) | Security alerts only; `PUSH_ENABLE_REAL=false` |

See [decisions-log.md](../registers/decisions-log.md) for the full chronological index.