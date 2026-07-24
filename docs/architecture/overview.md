# Architecture Overview (Phase 1 + Additive Alpha Gates)

```
                           ┌─────────────────────────────────────────────────┐
  Worker (Flutter)    ───▶ │          NestJS API (apps/api)                   │ ──emit──▶ events table
  Payer/Agency (Next.js)  │  auth/consent/chat/voice/profile/resume/workers   │            (event-first
  Admin Ops (Next.js)     │  + unlocks/jobs/applications/reach/pace/agency    │             audit log)
  WhatsApp (mock)         │  + payer-portal/pricing/capacity/messaging        │
                          └───────────────────────┬───────────────────────────┘
                                                  │ HTTP (no raw PII for LLM use)
                                                  ▼
                          ┌─────────────────────────────────────────────────┐
                          │         FastAPI AI (ai-service)                  │
                          │  pseudonymize (fail-closed) → mock/LLM          │ ──(gated)──▶ Gemini → Claude (direct)
                          │  + embeddings / canonicalization (offline)      │
                          └───────────────────────┬───────────────────────────┘
                                                  ▼
                                        Supabase Postgres (Drizzle)
                                                  │
                                                  ▼
                                        Redis + BullMQ (queues)
                                                  │
                        ┌─────────────────────────┼─────────────────────────┐
                        ▼                         ▼                         ▼
              profile-extraction           voice-transcription         resume-render
              (202 + poll)                  (async STT)                 (WeasyPrint PDF)
              deletion-sweep                retention-sweep             pace-waves
              (ADR-0031)                    (90-day ai_jobs)            (delayed widen)
```

## Principles

- **Event-first.** Every important endpoint emits an event that validates against
  `@badabhai/event-schema`. The `events` table is the spine + audit log (~105 event types registered).
- **Privacy boundary in the AI service.** Pseudonymization runs before any LLM
  call and **fails closed**. No phone/name/address/employer/ID reaches an LLM.
- **Typed contracts everywhere.** Zod (TS) + Pydantic (Python); shared packages
  for events, validators, config, taxonomy, AI contracts.
- **Repository/service separation** in the API over Drizzle; DI throughout.
- **Fail-closed gates** for all real external providers: `AI_ENABLE_REAL_CALLS`,
  `PAYMENTS_ENABLE_REAL`, `RESUME_RENDER_ENABLED`, `MESSAGING_ENABLE_REAL`,
  `PUSH_ENABLE_REAL` — all default `false`; require keys + human sign-off + staging-first.
- **RLS spine locked** (migration 0009): all 14 core tables have ENABLE + FORCE RLS +
  REVOKE from anon/authenticated/service_role/PUBLIC. Backend still connects as
  `postgres`/BYPASSRLS (TD4 open).

## Packages (shared)

`event-schema` (~105 events) · `db` (43 tables) · `config` (server/public split) ·
`types` · `validators` · `taxonomy` (15 alpha trades + ESCO/O*NET/NCO skills) ·
`ai-contracts` · `reach-engine` (deterministic RANK core, built) ·
`reach-learn` (offline LTR, built) · `pricing` (config-driven engine, built)

## Key Components (Additive Alpha Gates — Not Phase-1 Scope)

| Component | ADR | Status | Key Gates |
|-----------|-----|--------|-----------|
| Contact Unlock + Reveal (Stream A) | 0010 | ✅ Built + verified | Mock credits, in-app relay, `InternalServiceGuard`; LC-1..7 open |
| Reach feed serving (View A/B) | 0011/0015 | ✅ Built | Deterministic RANK core; TD36 deferrals |
| Ops job postings | 0012 | ✅ Built | Distinct from swipe `jobs`; TD37 |
| Monetization + pricing engine | 0013 | ✅ Built | Mock payments; boost ranking deferred (TD42 guarded) |
| Per-payer hiring capacity | 0016 | ✅ Built (inert) | `CAPACITY_ENFORCEMENT_ENABLED=false`; mock payments |
| Self-serve payer/agency portal | 0019 | ✅ Phase 1 built | `PayerAuthGuard` (LC-1); real payments + RLS + GA deferred |
| WhatsApp invite funnel | 0020 | ✅ Built (mock) | `MESSAGING_ENABLE_REAL=false` |
| PACE supply-widening | 0021 | ✅ Built (inert) | `PACE_ENABLED=false`; adjacent-trade gated (Q13) |
| Agency supply portal | 0022 | ✅ Backend + FE wired | KYC/payouts deferred; `AGENCY_PAYOUTS_ENABLED=false` |
| LEARN layer (offline LTR) | 0017 | ✅ Built (offline) | Live promotion = separate human gate |
| Model-training corpus | 0018 | ✅ Offline core built | GPU + real NER + live serving = human-gated |
| Production worker auth | 0026 | ✅ Phases 0-5 merged | TD55 hardening deferred |
| Worker-visible job fields | 0024 | ✅ Built | Employer identity hidden; banded pay shown |
| Account deletion (7-day grace) | 0031 | ✅ Built | Makes "7 din / cancel anytime" copy true |
| Skills taxonomy + canonicalization | 0030 | ✅ TAX-1..4 merged | TAX-5..9 pinned; fork-B seam |
| Push notifications (FCM) | 0034 | ✅ Built (inert) | Security alerts only; `PUSH_ENABLE_REAL=false` |

## Deferred (Launch Gates — Do Not Build Without Explicit Decision)

Reach Engine **learned** ranking, advanced matching, finalized RLS (least-privilege app role),
real OTP/STT/LLM/payment/telephony providers, production DPDP legal copy.
See `docs/decisions/0001-mvp-infra-decision.md` and CLAUDE.md §8.

---

**Table count:** 43 (source of truth: `packages/db/src/schema.ts`).
**Event registry:** ~105 event types (source of truth: `packages/event-schema/src/registry.ts`).
**Raw worker PII lives only in `workers`** (encrypted `phone_e164`/`full_name`; `phone_hash` peppered HMAC).
**Payer B2B PII** (email/phone/org name) encrypted in `payers` (TD21, ADR-0019 B-R2).
**Agency financial KYC** (PAN/bank) encrypted in `agency_kyc` (ADR-0022 Amdt 2, launch-gated OFF).
**Never** in events / `ai_jobs` / `audit_logs` / logs / LLM input.