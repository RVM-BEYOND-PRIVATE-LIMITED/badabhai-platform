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
| 1 | Router + Edit résumé | **Built + audit-fixed + WP1–WP6/WP8; flags ON in production.** Classifier model-live since 2026-10-01. The edit card is still **dark**: `companion_edit_parse` is off the box list, and the engineering prerequisites ("Never from chat", TD151(1), list normalisation, latency) are now merged — re-arming is the owner's step (checklist 6). Backend #1816/#1817/#1819/#1820, audit fixes #1869 + #1871, WPs #1972/#1974/#1988/#1986/#1994/#1997; worker-app F1–F6 #1827/#1834/#1867/#1880, TD151(2) issue #1977 |
| 2 | New résumé + Faltu | **Built + audit-fixed; flags ON in production** (deterministic paths live). Backend #1822, audit fixes #1872; worker-app F1/F2 #1827/#1834/#1867 |
| 3 | Career talk | **Built + audit-fixed + WP1/WP7; flags ON in production, model-live since 2026-10-01.** The career gate now refuses `\p{Cc}` (#1943), names law/health/money honestly, and checks the platform's own employer names (TD147). Backend #1825, audit fixes #1869 + #1872, WPs #1972/#1974/#1996; worker-app F1/F2 #1827 |

Update this table in the PR that finishes each phase.

**Production state (2026-10-01).** `CHAT_COMPANION_ENABLED` (v1) has been on since 2026-09-27. The
five `CHAT_COMPANION_V2_*` flags were set true on 2026-09-30 07:34 UTC, owner-authorized (#1843).
The Remote Config levers are true and unconditioned (Android; iOS has no Firebase config). The
owner armed all three model tasks (`companion_classify`, `companion_edit_parse`,
`companion_career_answer`) on the box's `AI_REAL_CALL_TASKS` on 2026-10-01 at ~07:04 UTC, over a
FAILING eval gate (#1877, #1883; step 2 below). The same day the production primary model was
measured turning "welder hata do" (drop the trade) into a delete of the worker's whole job (3/3,
`docs/qa/evidence/companion-v2/2026-10-01/`), so the owner
switched `companion_edit_parse` off the box again pending the "Never from chat" fix (rulings,
below): the edit card is **dark** (its mock returns no rows), while typed classification and
career answers are model-written. Migration 0130's DDL is applied in production.
Its ledger row is not adopted. No `chat.companion_turn_served_v2` row existed as of 2026-09-30.

**Audit (2026-09-30).** A full spec-vs-code audit verified 129 gaps, each independently re-checked.
The code gaps are fixed in #1869 (ai-service), #1871 (edit path: a confirmed edit now writes a real
`chat_edit` résumé version), #1872 (router + career validator) and TD145, plus worker-app #1867.
What remains is listed below.

**Engineering completion (2026-10-05).** The ten follow-up work packages landed on `main`:
WP1 #1972 (issue #1943), WP2 #1974, WP3 #1978, WP4 #1988, WP5 #1986, WP6 #1994, WP7 #1996,
WP8 #1997, WP9 #1998, WP10 (this PR). The edit-path safety work ("Never from chat" for
qualifications, list-member normalisation, no control characters, the classify prompt/budget
shrink, route precedence behind a new default-off flag, event v2s, the in-flight duplicate
claim) is all merged; the career validator now refuses the platform's own employer names and
stops over-blocking ordinary Hinglish. The box itself is untouched: flags, secrets,
`AI_REAL_CALL_TASKS` and the 30-answer review are the human steps below.

### Before the owner arms `AI_REAL_CALL_TASKS` (in this order)

1. **Sign** ADR-0046 and ADR-0044, or record a written waiver. Both are unsigned, and the flags are already on.
2. **Run the staging evals** per [`docs/ops/companion-v2-staging-evals-runbook.md`](../../ops/companion-v2-staging-evals-runbook.md).
   Record the results in `docs/qa/evidence/companion-v2/`. The bars:
   - `--classify`: ≥ 90 % accuracy, ≥ 95 % `edit_resume` precision, p95 < 1.5 s.
   - `--edit-parse`: ≥ 90 % exact, 0 rows outside the catalogue.
   - `--career`: 100 % safe on risky prompts, p95 < 4 s.

   The combined model + API-validator served rate (phase-3 §6, ≥ 85 %) is scored by the replay merged in #1883 (TD148, paid).
   **First run, 2026-10-01 (#1883, evidence `docs/qa/evidence/companion-v2/2026-10-01/`): FAIL on all three —
   do not append any task.** Classify misses p95 only (2411 / 1662 ms; quality passes); edit-parse 78.4 % exact
   with 3 out-of-catalogue rows; career 1 unsafe answer; served rate 80.4 %.
3. **Review 30 career answers** (`eval_cli --career --dump-samples 30`).
4. **Review the draft copy** in `contracts.md` §8: every `V2_*` line, the ask lines and the 39 card
   field labels. These drafts are already live where their flag is on. **The one defect named here
   is fixed (WP2, #1974):** `V2_CAREER_REFUSE.legal_medical_financial` now names law, health and
   money ("kanoon, sehat ya paise … vakil, doctor ya bank").
5. **Rule on** the open decisions: TD146 (v1 keyword resolver catches edit/career phrasings),
   TD147 (career validator: employer names, `SENSITIVE` over-blocking), TD149 (cost alert), the
   privacy go-ahead for stored employer values reaching edit-parse (masked once; an employer without
   a suffix passes, as ADR-0041 D5 accepts for résumé parsing), and the three P1 behaviours made
   without a recorded ruling: a chat-added language is `can_speak` only; availability is three
   sub-fields; preference lists allow member add/delete.
   **Ruled 2026-10-01 (owner): "Never from chat"** — chat never deletes a worker's whole job;
   whole-job deletes happen only on the Profile screen, and every employment field stays editable
   from chat. Reverses only the employment-delete half of P1-OQ2(b)
   ([phase-1 §5](phase-1-router-and-edit-resume.md#5-open-questions)).
   **Engineering now ships a provisional default for each open item** — TD146/TD147(1)/TD149 and
   the TD151(1) extension of "Never from chat" to qualifications — recorded in the table below
   with its revert path. Sign-off (or a reversal) is what is left of this item.
6. **Only then** append `companion_classify,companion_edit_parse`, and later `companion_career_answer`,
   to the box's own list, which overrides the compose default (see [`docs/environment-variables.md`](../../environment-variables.md)).
   Append, never replace. Then re-run the Deploy job of the newest `main` CI run.
7. Adopt the 0130 ledger row (`adopt-migrations.ts --only 0130_resume_generation_trigger_chat_edit`).

## Provisional rulings implemented (awaiting owner sign-off)

Where the register or the owner checklist says "owner decision", the engineering work packages took
the provisional default recorded here. Each is behind a flag, a copy row, or a trivially
revertible code change, and each names its revert path. Owner sign-off (or a reversal) is the
remaining action; nothing else is blocked on it.

| Decision | Provisional default | Why | Revert |
|---|---|---|---|
| **TD146 — v1-first routing** (WP6, 2026-10-05, #1994) | **A new flag `CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED` (default OFF).** With it on: a tap on Resume badlo / Career ki baat leaves a one-shot pending intent (Redis, 10 min) so the next free-text message goes straight to that handler; a narrow edit-verb + field-word table routes edit phrasings to the edit handler before v1; a v1 WEAK alias (menu substring aliases, résumé/greeting words, the bare `kaam`) goes to the classifier. Every NAMED v1 intent (exact chips, the menu's chips, jobs, applications, guarantee, status) keeps its zero-model answer. | The 2026-10-01 evidence showed "edit my resume", "location Mumbai kar do" and "welding ka kaam seekhna hai, kya karun" answered by v1's menus/digest, never by the edit card or a career answer. The brief's provisional default is exactly this; off is v1 byte-for-byte, pinned by `companion-v2.v1-first.test.ts`. | Set the flag `false` (already the default). Removing the feature is a code revert; the pending-intent key expires in 10 min. |
| **TD147(1) — employer names** (WP7, 2026-10-05, #1996) | **A platform employer-name index, fail closed.** `EmployersModule` reads the payer org names and worker-employment employer names the API already stores (ciphertext), decrypts them, strips legal suffixes and matches whole phrases / distinctive tokens (generic words like "steel"/"motors" never match alone), cached 15 min in memory. A match serves the fallback line. A never-loaded index is recorded and the `looksLikeOrgName` heuristic stands. | `looksLikeOrgName` is a suffix heuristic: "apply at Tata Motors or Maruti" passed the backstop and relied on the model's own refusal. | Delete the `employers/` module and the handler's `employerCheck` (or revert the commit). No flag, no persistent state. |
| **TD147(2)/(3) — validator walls** (WP7) | `case`, `policy` and `doctor` removed from `SENSITIVE`; µ (U+00B5/03BC) and Ω (U+03A9/2126) allowed as units. Court/vakil/lawyer/kanoon/dawai/ilaaj and the financial list still refuse. | "is case me", "safety policy" and first-aid "doctor ko dikhaiye" were ordinary Hinglish turned into fallbacks; µ/Ω are trade units, not another script. | Restore the three words in `career-output.validator.ts`; remove the unit symbols from `UNIT_SYMBOLS`. |
| **TD151(1) — qualification deletes** (WP3, 2026-10-05, #1978) | **Profile-only, fail closed** — mirroring the 2026-10-01 "Never from chat" ruling for jobs. A delete on any qualification field is dropped at propose (`whole_entry_delete`, reason `qualification_delete_from_chat`); the prompt routes a credential removal to `unsupported: ["other"]`; a stored ticked delete is refused at confirm. | "ITI hata do" / a trade word inside a certificate had the same whole-entry-delete shape as "welder hata do": one pre-ticked Haan. The owner's ruling did not cover them; the WP brief's default extends it. TD151(2) (unticked destructive rows) is Frontend issue **#1977**. | Restore `delete` on the qualification fields in `edit-catalogue.ts`, the qualification anchors in the prompt/gold set, or flip the `wholeEntryDelete` predicate to ignore qualifications. |
| **TD150 — analytics/idempotency** (WP8, 2026-10-05, #1997) | **Additive event versions + an in-flight claim:** turn_served v3 (`chip`), edit_cancelled v2 (`superseded`), edit_confirmed v2 (`skipped_no_consent`), edit_rolled_back v1, strike/career v2 with `submission_id`; a concurrent duplicate gets `V2_IN_FLIGHT` with no second model call/strike/event. | The register asked for these when the funnel is first read or a duplicate strike is reported; the WP brief names them an engineering item. The old emitters were changed, so nothing double-counts; v1/v2 stay registered. | Revert the commit; the `inflight:` keys expire in 60 s. |
| **TD149 — the cost alert** (WP9, 2026-10-05, #1998) | **O12 is satisfied by the admin dashboard; no push alert until an alerting channel exists.** The per-call `cost_alert` threshold was also **fixed from ₹20 to ₹5** (`ai_cost_alert_profile_inr`), because ₹20 sat ABOVE the ₹10 hard per-call ceiling, so the flag could never trip. | No push-alerting channel exists anywhere in the repo (`docs/observability-runbook.md`), and the dashboard already renders companion spend from `platform_ai_cost_totals`. A flag that cannot fire is worse than no flag; ₹5 is below the ceiling, so a call costing ₹5–10 is allowed AND alerts. | Alert threshold: change `ai_cost_alert_profile_inr` back to `20.0` (one number in `apps/ai-service/app/config.py`). "Dashboard only": no code change — building a channel is new work. |

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
