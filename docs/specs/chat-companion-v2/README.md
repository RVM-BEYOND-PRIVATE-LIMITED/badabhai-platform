# Chat Companion v2 — build spec

The "why" is [ADR-0046](../../decisions/0046-chat-companion-v2-llm-task-router.md). This folder is the
"what and how", written so an implementing agent can build one phase at a time without this
conversation.

| File | Contents |
|---|---|
| [`contracts.md`](contracts.md) | Shared contracts: intents, AI I/O schemas, wire fields, events, flags, Redis keys, copy keys |
| [`phase-1-router-and-edit-resume.md`](phase-1-router-and-edit-resume.md) | Router + Edit résumé |
| [`phase-2-new-resume-and-faltu.md`](phase-2-new-resume-and-faltu.md) | New résumé + Faltu (trash talk) |
| [`phase-3-career-talk.md`](phase-3-career-talk.md) | Career talk (Claude, Hinglish only) |

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | ADR-0046 written | Proposed — awaiting owner signature before any flag-ON |
| 1 | Router + Edit résumé | Not started |
| 2 | New résumé + Faltu | Not started |
| 3 | Career talk | Not started |

Update this table in the PR that finishes each phase.

## Architecture at a glance

```
Worker App (Flutter) — Bada Bhai tab
  text / voice (existing upload+transcribe) ─► POST /chat/companion/message        (existing)
  edit card Haan ─► POST /chat/companion/edits/:proposalId/confirm                 (new, Phase 1)
  edit card Nahi ─► POST /chat/companion/edits/:proposalId/cancel                  (new, Phase 1)
        │
apps/api/src/chat-companion/            (leaf module, ADR-0044)
  controller ─► ChatCompanionService (v1, unchanged path when v2 off)
                   └─► CompanionV2Orchestrator
                         ├─ CompanionTurnGuard      cool-down (Phase 2)
                         ├─ v1 resolveCompanionText (deterministic first, 0 model calls)
                         ├─ isAbusive lexicon       (Phase 2)
                         ├─ CompanionRouterClient ──► ai-service POST /companion/classify
                         └─ HandlerRegistry
                              ├─ EditResumeHandler   (P1) ──► ai-service POST /companion/edit-parse
                              ├─ NewResumeHandler    (P2)
                              ├─ FaltuHandler        (P2)
                              ├─ CareerTalkHandler   (P3) ──► ai-service POST /companion/career
                              ├─ JobsDeferredHandler (P1) fixed line
                              └─ UnclearHandler      (P1) clarify + task chips
                   CompanionEditService (P1): proposal store, confirm/cancel, apply-in-transaction,
                                              regenerate résumé (trigger chat_edit)
        │                         │                               │
   Postgres (writes only via   Redis (BullMQ connection)     apps/ai-service/app/companion/
   existing section writers)   proposals · memory · strikes  pseudonymize → AIRouter → validate
```

## Rules for the implementing agent (opencode now, Claude Code later)

Read before writing code: `CLAUDE.md`, ADR-0044, ADR-0046, this folder, and the v1 module
`apps/api/src/chat-companion/` (start with `chat-companion.service.ts` and its tests).

1. **One phase per PR.** Each phase has its own checklist; do not mix phases.
2. **Do not edit** `apps/api/src/chat/chat.service.ts`, `apps/api/src/chat/resume-menu.ts`, the
   interview engine, or `apps/api/src/profiling/orchestrator.service.ts`. Import from them only
   where v1 already does.
3. **Never write** `chat_sessions` or `chat_messages`. The boot egress test
   (`chat-companion.module.boot.test.ts`) must stay green and must be extended for new providers.
4. **Never send raw worker text to a model from the API.** All model calls go through
   `AiService` → ai-service, which pseudonymizes at the endpoint before `AIRouter`.
5. **Never log worker text** and never put it in an event. Events carry ids, counts, closed enums.
6. **Flag off ⇒ v1 byte-for-byte.** Add a test that proves it for each new flag.
7. **Additive only.** New optional wire fields, new routes, new event versions. Never mutate an
   existing event schema or remove a field.
8. **Controllers are HTTP only; services hold logic; repositories only query.** (CLAUDE.md §4)
9. **Every model output is untrusted.** Validate with Zod (API) / Pydantic (ai-service) before use.
10. **Quality gates before every push:** `pnpm lint`, `pnpm typecheck`, `pnpm test` (or the
    filtered package: `pnpm --filter @badabhai/api test`), and in `apps/ai-service`: `pytest`.
11. **Git identity:** commits are authored by the responsible developer, never by an AI identity
    (CLAUDE.md "Git Commit Attribution").
12. **When the spec is silent or ambiguous, stop and ask** (CLAUDE.md §16). Do not invent business
    rules. Log the question in the phase file's "Open questions" section.

## Ownership (CLAUDE.md §5–6)

| Layer | Owner | Where |
|---|---|---|
| API, DB, events, flags | Backend Platform | `apps/api`, `packages/db`, `packages/event-schema`, `packages/types`, `packages/config` |
| AI service, prompts, evals | Backend Platform (AI) | `apps/ai-service`, `packages/ai-contracts` |
| Worker app | Frontend Platform | `apps/worker-app` — raised as a GitHub issue per phase |
| Deploy env wiring | DevOps | `.github/workflows/ci.yml` env list, `docs/environment-variables.md` |

## Prerequisites for turning anything on

1. Companion v1 live: ADR-0044 signed; worker-app build with #1809, #1766 and #1769 rolled out;
   TD145 fixed.
2. ADR-0046 signed.
3. Staging first (Remote Config conditioned to test devices), then widen.
