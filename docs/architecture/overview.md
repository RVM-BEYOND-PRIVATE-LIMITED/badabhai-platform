# Architecture Overview (Phase 1)

```
                         ┌───────────────────────────┐
  Worker (Flutter)  ───▶ │   NestJS API (apps/api)    │ ──emit──▶  events table
                         │  auth/consent/chat/voice/  │            (event-first
  Ops (Next.js)     ───▶ │  profile/resume/workers    │             audit log)
                         └─────────────┬──────────────┘
                                       │ HTTP (no raw PII for LLM use)
                                       ▼
                         ┌───────────────────────────┐
                         │  FastAPI AI (ai-service)   │
                         │  pseudonymize → mock/LLM   │ ──(gated)──▶ Gemini→Claude (direct)
                         └─────────────┬──────────────┘
                                       ▼
                              Supabase Postgres (Drizzle)
```

## Principles

- **Event-first.** Every important endpoint emits an event that validates against
  `@badabhai/event-schema`. The `events` table is the spine + audit log.
- **Privacy boundary in the AI service.** Pseudonymization runs before any LLM
  call and **fails closed**. No phone/name/address/employer/ID reaches an LLM.
- **Typed contracts everywhere.** Zod (TS) + Pydantic (Python); shared packages
  for events, validators, config, taxonomy, AI contracts.
- **Repository/service separation** in the API over Drizzle; DI throughout.

## Packages (shared)

`event-schema` · `db` · `config` · `types` · `validators` · `taxonomy` ·
`ai-contracts` · `reach-engine` (placeholder).

## Deferred (Phase 2+)

Reach Engine ranking, employer/unlock, payments, finalized RLS, BullMQ job
queues, real provider integrations. See `docs/decisions/0001-mvp-infra-decision.md`.
