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
| 0 | ADR-0046 written | **Proposed — still unsigned**, although the flags are ON (below) |
| 1 | Router + Edit résumé | **Built + audit-fixed; flags ON in production, model path dark.** Backend #1816/#1817/#1819/#1820, audit fixes #1869 + #1871; worker-app F1–F5 #1827/#1834/#1867; **F6 (row labels) open — #1876** |
| 2 | New résumé + Faltu | **Built + audit-fixed; flags ON in production** (deterministic paths live). Backend #1822, audit fixes #1872; worker-app F1/F2 #1827/#1834/#1867 |
| 3 | Career talk | **Built + audit-fixed; flags ON in production, model path dark.** Backend #1825, audit fixes #1869 + #1872; worker-app F1/F2 #1827 |

Update this table in the PR that finishes each phase.

**Production state (2026-10-01).** `CHAT_COMPANION_ENABLED` (v1) has been on since 2026-09-27. The
five `CHAT_COMPANION_V2_*` flags were set true on 2026-09-30 07:34 UTC, owner-authorized (#1843).
The Remote Config levers are true and unconditioned (Android; iOS has no Firebase config). The
model-written paths (the edit card, typed classification, career answers) are **dark** only because
the box's `AI_REAL_CALL_TASKS` does not name the companion tasks yet. Until it does, the classifier
mock answers `unclear` and career gets the refusal. Migration 0130's DDL is applied in production.
Its ledger row is not adopted. No `chat.companion_turn_served_v2` row existed as of 2026-09-30.

**Audit (2026-09-30).** A full spec-vs-code audit verified 129 gaps, each independently re-checked.
The code gaps are fixed in #1869 (ai-service), #1871 (edit path: a confirmed edit now writes a real
`chat_edit` résumé version), #1872 (router + career validator) and TD145, plus worker-app #1867.
What remains is listed below.

### Before the owner arms `AI_REAL_CALL_TASKS` (in this order)

1. **Sign** ADR-0046 and ADR-0044, or record a written waiver. Both are unsigned, and the flags are already on.
2. **Run the staging evals** per [`docs/ops/companion-v2-staging-evals-runbook.md`](../../ops/companion-v2-staging-evals-runbook.md).
   Record the results in `docs/qa/evidence/companion-v2/`. The bars:
   - `--classify`: ≥ 90 % accuracy, ≥ 95 % `edit_resume` precision, p95 < 1.5 s.
   - `--edit-parse`: ≥ 90 % exact, 0 rows outside the catalogue.
   - `--career`: 100 % safe on risky prompts, p95 < 4 s.

   The combined model + API-validator served rate (phase-3 §6, ≥ 85 %) has no harness yet (TD148).
3. **Review 30 career answers** (`eval_cli --career --dump-samples 30`).
4. **Review the draft copy** in `contracts.md` §8: every `V2_*` line, the ask lines and the 39 card
   field labels. These drafts are already live where their flag is on. Fix `V2_CAREER_REFUSE.legal_medical_financial`,
   which sends a health question to "a lawyer or a bank".
5. **Rule on** the open decisions: TD146 (v1 keyword resolver catches edit/career phrasings),
   TD147 (career validator: employer names, `SENSITIVE` over-blocking), TD149 (cost alert), the
   privacy go-ahead for stored employer values reaching edit-parse (masked once; an employer without
   a suffix passes, as ADR-0041 D5 accepts for résumé parsing), and the three P1 behaviours made
   without a recorded ruling: a chat-added language is `can_speak` only; availability is three
   sub-fields; preference lists allow member add/delete.
6. **Only then** append `companion_classify,companion_edit_parse`, and later `companion_career_answer`,
   to the box's own list, which overrides the compose default (see [`docs/environment-variables.md`](../../environment-variables.md)).
   Append, never replace. Then re-run the Deploy job of the newest `main` CI run.
7. Adopt the 0130 ledger row (`adopt-migrations.ts --only 0130_resume_generation_trigger_chat_edit`).

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

Status 2026-10-01:
- (1) v1 is live, but ADR-0044 is unsigned. The builds are rolled out, and TD145 is fixed.
- (2) ADR-0046 is unsigned.
- (3) This step was skipped. The Remote Config levers are unconditioned, and the server flags have
  no per-worker cohort, so a server flag flips v2 for every companion worker at once. The
  checklist under "Status" is the remaining path.
