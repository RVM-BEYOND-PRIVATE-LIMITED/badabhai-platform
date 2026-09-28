# Phase 1 — Router + Edit résumé

**Goal:** a confirmed worker types (or speaks) free text on the Bada Bhai tab. v1 still answers
everything it understands. Anything else is classified by the model. "Edit my résumé" requests
become a confirm card; a tap applies them and regenerates the résumé. Every other intent gets a
fixed line and task chips.

Contracts: [`contracts.md`](contracts.md). Why: [ADR-0046](../../decisions/0046-chat-companion-v2-llm-task-router.md)
O1–O6, O8, O12–O17.

## 1. Flow

```
POST /chat/companion/message {text}
  policy → interview? 409 (unchanged)
  CHAT_COMPANION_V2_ENABLED off → v1 path (unchanged)
  v1 resolveCompanionText hit → v1 answer (unchanged, 0 model calls)
  miss:
    classify (ai-service /companion/classify, memory: last 2 turns)
      edit_resume & EDIT flag on → EditResumeHandler
      jobs_talk                  → V2_JOBS_DEFERRED + task chips
      other / phase flag off     → V2_PHASE_OFF + task chips
      unclear                    → V2_CLARIFY + task chips
  append pseudonymized turn pair to memory
  emit chat.companion_turn_served v2
```

### Edit résumé

```
EditResumeHandler
  1. snapshot  ← read current confirmed profile sections (catalogue §3), mint refs e1, e2, …
  2. parse     ← ai-service /companion/edit-parse {text, catalogue, snapshot, max_rows}
  3. validate each row (deterministic):
       section in catalogue · op allowed for section · ref exists (edit/delete)
       value passes the section writer's DTO schema
       value contains no placeholder token (O17) → else drop
       skills: phrase → skill_id via ADR-0030 canonicalizer (floor 0.75) → else drop
       identical to current value → drop
  4. rows = 0  → V2_EDIT_NONE (+ V2_EDIT_IDENTITY if unsupported ∋ identity|contact)
     rows ≥ 1  → store proposal in Redis (ref → real row id resolved server-side, before-values
                 captured for the stale check), reply V2_EDIT_CARD_INTRO + edit_proposal
  5. emit chat.companion_edit_proposed

POST /chat/companion/edits/:id/confirm {row_ids}
  1. load proposal under this worker's key → none: 404
  2. policy → interview? 409
  3. stale check: every selected row's current value == captured before-value → else
     delete proposal, V2_EDIT_STALE, emit cancelled(stale), 409 {reason:"stale"}
  4. apply selected rows in ONE transaction through the catalogue writers
     any failure → rollback, V2_FALLBACK, proposal kept (worker may retry until TTL)
  5. delete proposal; enqueue résumé regenerate (trigger chat_edit, daily cap applies)
       queued → V2_EDIT_DONE · capped → V2_EDIT_DONE_CAPPED · failed → V2_EDIT_DONE_CAPPED copy
  6. emit chat.companion_edit_confirmed

POST /chat/companion/edits/:id/cancel → delete proposal, V2_EDIT_CANCELLED, emit cancelled(worker)
```

A new edit message while a proposal is open replaces it (one active proposal per worker).

## 2. Tasks

### Backend — API (`apps/api/src/chat-companion/`)

- [x] **T0 Verify writers.** For each catalogue section, record the writer's method, DTO, transaction
      support and own events in `contracts.md` §3. Add an optional `tx` param where needed (additive).
      Remove a section from the catalogue if it cannot be made transactional; note it below.
      Findings: `contracts.md` §3 + §3.1; `tx` params are deferred to T7; `skills` is blocked (P1-OQ1).
- [ ] **T1 Types.** `packages/types`: intents, sources, outcomes (contracts §1).
- [ ] **T2 Config.** `packages/config`: v2 flags + knobs (contracts §6). `docs/environment-variables.md`.
- [ ] **T3 Events.** `packages/event-schema`: `chat.companion_turn_served` v2, `chat.companion_edit_*` v1
      (contracts §4) + registry entries + schema tests.
- [ ] **T4 AI client.** `apps/api/src/ai/ai.service.ts`: `companionClassify`, `companionEditParse`
      (follow `jobPostingChatRespond`'s pattern: `this.post(path, input, OutputSchema, timeoutMs, ctx)`,
      null on failure). Timeouts: classify 3 s, edit-parse 6 s.
- [ ] **T5 Redis stores.** `v2/companion-memory.store.ts`, `v2/edit-proposal.store.ts` (contracts §7),
      BullMQ connection reuse, fail-soft reads.
- [ ] **T6 Orchestrator.** `v2/companion-v2.orchestrator.ts` + `v2/handlers/*.ts`
      (`EditResumeHandler`, `JobsDeferredHandler`, `PhaseOffHandler`, `UnclearHandler`), a
      `HandlerRegistry` keyed by intent. `ChatCompanionService.message` delegates to the
      orchestrator only when the v2 flag is on AND v1 resolution missed.
- [ ] **T7 Edit catalogue + service.** `v2/edit-catalogue.ts`, `v2/companion-edit.service.ts`
      (snapshot, validate, propose, confirm-in-transaction, cancel, regenerate).
- [ ] **T8 Controller routes.** `confirm` / `cancel` in `chat-companion.controller.ts` (HTTP only),
      DTOs in `chat-companion.dto.ts`, additive `edit_proposal` on `CompanionTurnSchema`.
- [ ] **T9 Résumé trigger.** `packages/types` `RESUME_GENERATION_TRIGGERS` += `chat_edit`;
      migration **`0130`** widens `generated_resumes_generation_trigger_chk` (drop + re-add the CHECK
      with the extra value; down migration restores the old list). Claim `0130` in `MIGRATIONS.md`.
      `ResumeService` accepts the trigger; the daily cap applies.
- [ ] **T10 Copy.** `companion-replies.ts` keys (contracts §8) with Devanagari twins; task chip keys in
      `companion-keys.ts`.

### Backend — AI service (`apps/ai-service/app/`)

- [ ] **A1 Contracts.** `contracts.py` models for classify and edit-parse + `packages/ai-contracts`
      Zod mirror + parity test.
- [ ] **A2 Module.** `app/companion/{__init__,classify,edit_parse,prompts}.py`,
      `app/routers/companion.py`, registered in `main.py`. Each endpoint: validate input →
      `pseudonymize` (blocked → return `blocked:true` / empty rows) → `AIRouter` → parse → validate →
      return. Deterministic `mock_response` for mock mode.
- [ ] **A3 Model routes.** `model_config.py`: tasks `companion_classify`, `companion_edit_parse`
      (tier `cheap` → Gemini Flash, json_mode on, low temperature). Prompts in the prompt registry.
- [ ] **A4 Evals.** `apps/ai-service/tests/companion/`:
      classifier set ≥ 150 labelled Hinglish / Hindi / English lines across all 6 intents
      (incl. typos, voice-transcript style, mixed script); edit-parse set ≥ 60 cases across all
      sections, ops and multi-row messages. Regression test fails below the targets in §4.

### Frontend — worker app (GitHub issue for Frontend Platform)

- [ ] **F1** Render `edit_proposal` as a card: rows with checkboxes (all ticked), Haan / Nahi,
      disabled after `expires_at`. Haan → confirm route with ticked `row_ids`; Nahi → cancel route.
- [ ] **F2** Task chips (`companion_task:*`) rendered from `options`; tapping sends the chip label as text.
- [ ] **F3** Voice button on the companion composer: existing voice upload + transcribe flow; the
      transcript is placed in the composer for the worker to review and send (consent
      `voice_processing` as today).
- [ ] **F4** Remote Config `worker_chat_companion_v2_enabled` gates F1–F3.
- [ ] **F5** Keys parity: `chat_companion_keys.dart` += task chip keys (parity test).

### DevOps

- [ ] Add the v2 flags to the `ci.yml` deploy env list (as `CHAT_COMPANION_ENABLED` is).
- [ ] Cost dashboard + alert on `ai_jobs` for tasks `companion_*` (O12: watch, don't cap).

## 3. Tests that must exist

| Test | Proves |
|---|---|
| `companion-v2.flag-off.test.ts` | v2 off ⇒ every existing v1 test fixture yields the identical turn |
| `companion-v2.v1-first.test.ts` | every v1 chip / alias / intent resolves without a model call |
| `companion-v2.orchestrator.test.ts` | each intent → correct handler; null / low-confidence / blocked → clarify |
| `companion-edit.validate.test.ts` | each drop rule (catalogue, op, ref, DTO, token, skill floor, no-op) |
| `companion-edit.confirm.test.ts` | ownership 404; stale 409; transaction rollback on a writer failure; regenerate queued / capped |
| `companion-edit.no-identity.test.ts` | name / phone / ID requests never produce a row; `V2_EDIT_IDENTITY` served |
| `chat-companion.module.boot.test.ts` (extended) | still no chat-table writers reachable from the module |
| `companion-v2.privacy.test.ts` | no worker text in events, logs (spy on Logger) or Redis memory beyond pseudonymized text |
| `companion-replies.test.ts` (extended) | every new line passes persona checks and has a matching twin |
| event-schema tests | new/v2 payloads `.strict()`, reject text fields |
| ai-service `test_companion_*` | contracts parity; blocked input; mock mode; eval thresholds |

## 4. Acceptance

- Flags off: no behaviour change, no model call (asserted).
- Classifier eval: ≥ 90 % accuracy overall, ≥ 95 % precision on `edit_resume`.
- Edit-parse eval: ≥ 90 % of cases yield exactly the expected rows; 0 rows ever outside the catalogue.
- "Welding bhi add karo aur Hindi hata do" → one card, 2 rows; Haan with both ticked → both applied,
  résumé regenerated (trigger `chat_edit`), one `edit_confirmed` event.
- "Mera naam badlo" → no card, `V2_EDIT_IDENTITY`.
- Profile edited elsewhere between card and Haan → stale reply, nothing written.
- Writer failure on row 2 → nothing written (rollback), fallback line.
- AI service down → clarify line + chips, no error to the worker.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pytest` green.

## 5. Open questions

Add questions here rather than guessing (README rule 12).

- **P1-OQ1 — `skills` has no writer (T0 finding, 2026-09-28).** `contracts.md` §3 names
  `WorkerSkillsService.setWants` as the skills writer, but that method is an unwired seam that
  throws by design (`apps/api/src/match/worker-skills.service.ts:187`). No existing writer can
  add/delete a wanted skill. The only working skills-edit path is `ExtractedCorrectionsService`
  field `skills`, which needs a pinned chat session + profile id and replaces the whole authored
  list with canonical `skill_*` ids (never a phrase). Options:
  **(a)** drop `skills` from the Phase 1 catalogue and serve "Profile screen" guidance;
  **(b)** build an additive skills writer (add/delete wanted rows + `job_reach` reconcile) and
  canonicalize phrases through `AiService.canonicalizeSkill`, honoring the 0.75 floor;
  **(c)** route through the corrections path with its pinned-session requirement.
  Owner/architect ruling needed before T7. Until then, T1–T6 proceed (they do not depend on it).
