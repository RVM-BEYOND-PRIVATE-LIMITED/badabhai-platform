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

**The "Resume badlo" task chip (2026-09-30).** A tap is recognised (exact label/key, before v1 — the
P2 chip step) only while `CHAT_COMPANION_V2_EDIT_ENABLED` is on, and is answered with the fixed
`V2_EDIT_ASK` line + task chips: no snapshot read, no edit-parse call (the label names no change, so
the parse could only ever return zero rows → `V2_EDIT_NONE`). The worker's next message — "Marathi
bhasha jod do" — takes the flow above. With the flag off the label is typed text and v1 answers it
(the recap), as before the chip existed.

### Edit résumé

```
EditResumeHandler
  1. snapshot  ← read current confirmed profile sections (catalogue §3), mint refs e1, e2, …
                 cut to the contract's 64 rows, deterministically (contracts §2.2)
  2. parse     ← ai-service /companion/edit-parse {text, catalogue, snapshot,
                 max_rows = min(EDIT_MAX_ROWS, 3)}
  3. validate each row (deterministic):
       section in catalogue · op allowed for section · ref exists AND was sent (edit/delete)
       the field belongs to the ref's entry: a qualification field names the ref's list, any
         other field is one of that row's keys (EDIT-ROW-KIND, contracts §3.2) → else drop
       value passes the field's normalisation
       value contains no placeholder token (O17) → else drop
       value carries no hard identifier (ADR-0047 G1; the ai-service drops it first) → else drop
       skills: phrase → skill_id via ADR-0030 canonicalizer (floor 0.75) → else drop
         (superseded: owner ruling 2026-09-28 made skills résumé-only labels — no canonicalizer)
       identical to current value → drop
     then the row set (contracts §3.2): duplicates, an edit of an entry the card also deletes and
     an ADD OF SOMETHING ALREADY STORED → drop; every row must pass the section writer's REAL
     DTO schema together with the rows before it → else drop; cap at max_rows
  4. rows = 0  → V2_EDIT_IDENTITY if unsupported ∋ identity|contact OR the message names the
                 worker's own name / phone / ID number (deterministic, no model);
                 else V2_EDIT_PLACEHOLDER (DRAFT) if a row was dropped for a placeholder token;
                 else V2_EDIT_NONE
     rows ≥ 1  → store proposal in Redis (ref → real row id resolved server-side, before-values
                 captured for the stale check), reply V2_EDIT_CARD_INTRO + edit_proposal
                 (each row: field_label + before/after_display, derived at wire time — §5.1)
  5. emit chat.companion_edit_proposed

POST /chat/companion/edits/:id/confirm {row_ids}
  1. load proposal under this worker's key → none: 404
     past its expires_at → 404, emit cancelled(expired) (the record outlives the card by 300 s)
  2. policy → interview? 409
  2b. CLAIM the card (SET NX) → already claimed: 404 · Redis refused: V2_FALLBACK + the card
  3. re-read the sections once; one that cannot be read → release the claim, V2_FALLBACK + the
     card (nothing is known, so it is not "stale")
     stale check: every selected row's current value == captured before-value (qualifications
     matched by fingerprint, never by index; a field its entry lacks is stale) → else
     delete proposal, V2_EDIT_STALE, emit cancelled(stale), 409 {reason:"stale", turn}
  4. apply selected rows in ONE transaction through the catalogue writers, built from the state
     the stale check read (contracts §3.2)
     any failure → rollback, release the claim, V2_FALLBACK carrying the SAME edit_proposal,
     proposal kept (worker may retry until TTL)
  5. delete proposal; a shift row seeds night-shift readiness exactly as the form does
     (WorkerPreferencesService.seedNightShiftReadyFromShift, after commit); occupations rebuild;
     enqueue résumé regenerate (trigger chat_edit, daily cap applies)
       consent must name resume_generation, else failed (no cap slot, no model call)
       ResumeService.queueChatEditRegeneration: cap charged ON THIS REQUEST, then a
       resume-generate job {trigger:"chat_edit"}; the job writes a NEW history entry
       (never the profile's initial row) and queues its render — contracts §4
       queued → V2_EDIT_DONE · capped → V2_EDIT_DONE_CAPPED · failed → V2_EDIT_DONE_CAPPED copy
       not queued + a live-printed section changed (all but skills) → ONE LLM-free re-render
       of the latest résumé (ResumeRerenderService.enqueueLatest) — contracts §3.2
  6. emit chat.companion_edit_confirmed

POST /chat/companion/edits/:id/cancel → past expires_at: 404 + cancelled(expired);
  claimed by a Haan in flight: 404; else delete proposal, V2_EDIT_CANCELLED, emit cancelled(worker)
```

A new edit message while a proposal is open replaces it (one active proposal per worker).

## 2. Tasks

### Backend — API (`apps/api/src/chat-companion/`)

- [x] **T0 Verify writers.** For each catalogue section, record the writer's method, DTO, transaction
      support and own events in `contracts.md` §3. Add an optional `tx` param where needed (additive).
      Remove a section from the catalogue if it cannot be made transactional; note it below.
      Findings: `contracts.md` §3 + §3.1; `tx` params are deferred to T7; `skills` resolved by
      P1-OQ1 (résumé-only writer, T7).
- [x] **T1 Types.** `packages/types`: intents, sources, outcomes (contracts §1).
- [x] **T2 Config.** `packages/config`: v2 flags + knobs (contracts §6). `docs/environment-variables.md`.
- [x] **T3 Events.** `packages/event-schema`: `chat.companion_turn_served` v2, `chat.companion_edit_*` v1
      (contracts §4) + registry entries + schema tests.
- [x] **T4 AI client.** `apps/api/src/ai/ai.service.ts`: `companionClassify`, `companionEditParse`
      (follow `jobPostingChatRespond`'s pattern: `this.post(path, input, OutputSchema, timeoutMs, ctx)`,
      null on failure). Timeouts: classify 3 s, edit-parse 6 s.
- [x] **T5 Redis stores.** `v2/companion-memory.store.ts`, `v2/edit-proposal.store.ts` (contracts §7),
      BullMQ connection reuse, fail-soft reads.
- [x] **T6 Orchestrator.** `v2/companion-v2.orchestrator.ts` + `v2/handlers/*.ts`
      (`EditResumeHandler`, `JobsDeferredHandler`, `PhaseOffHandler`, `UnclearHandler`), a
      `HandlerRegistry` keyed by intent. `ChatCompanionService.message` delegates to the
      orchestrator only when the v2 flag is on AND v1 resolution missed.
      "Missed" is v1's own `fallback` intent — every NAMED v1 intent (digest, jobs, applied,
      guarantee) and every menu alias still takes the v1 branch, proved by
      `companion-v2.v1-first.test.ts`.
- [x] **T7 Edit catalogue + service.** `v2/edit-catalogue.ts`, `v2/companion-edit.service.ts`
      (snapshot, validate, propose, confirm-in-transaction, cancel, regenerate).
- [x] **T8 Controller routes.** `confirm` / `cancel` in `chat-companion.controller.ts` (HTTP only),
      DTOs in `chat-companion.dto.ts`, additive `edit_proposal` on `CompanionTurnSchema`.
- [x] **T9 Résumé trigger.** `packages/types` `RESUME_GENERATION_TRIGGERS` += `chat_edit`;
      migration **`0130`** widens `generated_resumes_generation_trigger_chk` (drop + re-add the CHECK
      with the extra value; down migration restores the old list). Claim `0130` in `MIGRATIONS.md`.
      `ResumeService` accepts the trigger; the daily cap applies.
      Fix 2026-09-30 (lane a1): the first cut sent `chat_edit` down the system path's
      insert-if-absent INITIAL row, which on an already-confirmed profile returned the old
      résumé (no new row, a paid model call and a cap slot spent). `chat_edit` now takes a
      new-entry path and runs queued; `resume-chat-edit.db.test.ts` pins it on a real Postgres.
- [x] **T10 Copy.** `companion-replies.ts` keys (contracts §8) with Devanagari twins; task chip keys in
      `companion-keys.ts`.
      Deviation: the task keys live in `companion-task-keys.ts`, because `companion-keys.ts` is
      pinned verbatim by the worker app's parity test (adding keys there reddens the Flutter suite
      before F5 ships). Frontend issue raised.

### Backend — AI service (`apps/ai-service/app/`)

- [x] **A1 Contracts.** `contracts.py` models for classify and edit-parse + `packages/ai-contracts`
      Zod mirror + parity test.
- [x] **A2 Module.** `app/companion/{__init__,classify,edit_parse,prompts}.py`,
      `app/routers/companion.py`, registered in `main.py`. Each endpoint: validate input →
      `pseudonymize` (blocked → return `blocked:true` / empty rows) → `AIRouter` → parse → validate →
      return. Deterministic `mock_response` for mock mode.
      Note: the two `model_config` task routes landed here too — the endpoints cannot be green
      without them (the router RAISES on an unknown task, and two guard tests say so).
      Audit fix (2026-09-30): the edit-parse prompt requires a catalogue `field` on EVERY row,
      delete included, and names the delete anchor per row kind; `parse_edit_rows` drops a
      field-less row (the API dropped it unseen, so "Hindi hata do" could vanish from the
      "Welding bhi add karo aur Hindi hata do" card). Contract note: `contracts.md` §2.2.
      Audit fix (2026-09-30): the message and every snapshot value are masked with ONE
      request-scoped `TokenScope`, so a worker's several employers no longer all read
      `[EMPLOYER_1]` and the message's token points at one row (`contracts.md` §2.2).
- [x] **A3 Model routes.** `model_config.py`: tasks `companion_classify`, `companion_edit_parse`
      (tier `cheap` → Gemini Flash, json_mode on, low temperature). Prompts in the prompt registry.
      The route shapes landed with A2 (the endpoints cannot be green without them); A3 added the
      registry names + registration, the trace names, and `test_companion_routes.py`.
- [x] **A4 Evals.** `apps/ai-service/tests/companion/`:
      classifier set ≥ 150 labelled Hinglish / Hindi / English lines across all 6 intents
      (incl. typos, voice-transcript style, mixed script); edit-parse set ≥ 60 cases across all
      sections, ops and multi-row messages. Regression test fails below the targets in §4.
      158 classifier lines + 74 edit cases; the real accuracy bars gate in
      `python -m app.companion.eval_cli` (staging), and CI gates set shape, scorer capability,
      catalogue containment and the TS↔gold catalogue parity.
      Audit fix (2026-09-30): the CLI scores what production routes — below the API's
      confidence floor (`--min-confidence`, default = the `CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE`
      default, pinned to `packages/config`) a classification counts as `unclear`, and a response
      slower than the API's own timeout (3 s / 6 s, pinned to `ai.service.ts`) counts as no
      answer. A failed call is retried once, then scored as no answer and listed (the run no
      longer aborts); a mock answer marks the run CONTAMINATED; either fails the gate. Latency
      is measured per call and the classifier gates on p95 < 1.5 s (ADR-0046 §4). Procedure:
      `docs/ops/companion-v2-staging-evals-runbook.md`.

### Frontend — worker app (GitHub issue for Frontend Platform)

- [ ] **F1** Render `edit_proposal` as a card: rows with checkboxes (all ticked), Haan / Nahi,
      disabled after `expires_at`. Haan → confirm route with ticked `row_ids`; Nahi → cancel route.
- [ ] **F2** Task chips (`companion_task:*`) rendered from `options`; tapping sends the chip label as text.
- [ ] **F3** Voice button on the companion composer: existing voice upload + transcribe flow; the
      transcript is placed in the composer for the worker to review and send (consent
      `voice_processing` as today).
- [ ] **F4** Remote Config `worker_chat_companion_v2_enabled` gates F1–F3.
- [ ] **F5** Keys parity: `chat_companion_keys.dart` += task chip keys (parity test).
- [ ] **F6** (2026-09-30, lane a3 — BUG-CARD-LABELS) Show each row's `field_label` beside
      `section_label`, and prefer `before_display` / `after_display` over `companionEditValue`
      when non-null (contracts §5.1). The API sends them on every card; the humaniser stays as
      the fallback for an older server. Frontend issue needed.

### DevOps

- [x] Add the v2 flags to the `ci.yml` deploy env list (as `CHAT_COMPANION_ENABLED` is).
      All five phase flags are bridged end-to-end (`ci.yml` `env:` + `envs:`,
      `docker-compose.staging.yml` `${VAR:-false}`), the knobs deliberately are not; the
      guard test pins each hop and the defaults.
- [x] Cost dashboard + alert on `ai_jobs` for tasks `companion_*` (O12: watch, don't cap).
      THE LEDGER IS NOW REAL: both endpoints return `ai_metadata` (A2 discarded it) and the
      API records the spend through `AiCostRecorder` against `companion_classify` /
      `companion_edit_parse` — so `ai.cost_recorded` and `platform_ai_cost_totals` accrue
      and the admin dashboard's raw `by_task_type` buckets (and its panel) render the
      companion spend with no further change. Note the checklist's wording: the record is
      the ledger (event + totals), NOT an `ai_jobs` row — inline calls have no `ai_jobs`
      row by #745's design. The "alert" is the existing per-call `cost_alert` flag that now
      rides companion `ai.cost_recorded` events (threshold `ai_cost_alert_profile_inr`, an
      owner config); there is no push alerting anywhere in the repo
      (`docs/observability-runbook.md`), and per O12 nothing is capped.

## 3. Tests that must exist

| Test | Proves |
|---|---|
| `companion-v2.flag-off.test.ts` | v2 off ⇒ every existing v1 test fixture yields the identical turn |
| `companion-v2.v1-first.test.ts` | every v1 chip / alias / intent resolves without a model call |
| `companion-v2.orchestrator.test.ts` | each intent → correct handler; null / low-confidence / blocked → clarify |
| `companion-edit.validate.test.ts` | each drop rule (catalogue, op, ref, a field of another entry kind, DTO, token, hard identifier (ADR-0047 G1), skill floor, no-op) — incl. no-op ADDS, duplicates, the writer's real schema, the row cap, the snapshot cap, the O17 Profile-screen line |
| `companion-edit.confirm.test.ts` | ownership 404; stale 409; transaction rollback on a writer failure (row 2 fails → row 1 undone); regenerate queued / capped / failed; consent off → no regeneration; not queued → one re-render (none for skills-only, queued or a rollback); at most one apply per card (concurrent / retried Haan); a rollback serves the card again; expired → cancelled(expired) |
| `companion-edit.apply.test.ts` | the body each writer receives: preferences `touched_only` + folded lists, qualifications by identity and only the touched lists, skills never duplicated, the night-shift seed after commit |
| `edit-catalogue.test.ts` | every catalogue field has a `field_label` (distinct within its section, no orphan); a whole-entry delete names the entry, by its target's list; every closed-set value maps to its dictionary's display label; free text, unknown slugs and nulls → null |
| `resume-chat-edit.db.test.ts` (`RUN_DB_TESTS=1`) | a Haan on a profile that already has its v1 writes a NEW `chat_edit` row from the edited profile; a second edit is another; a queue retry does not duplicate |
| `companion-edit.no-identity.test.ts` | name / phone / ID requests never produce a row; `V2_EDIT_IDENTITY` served — also when the model gives no hint (the deterministic check, `edit-identity.test.ts`) |
| `chat-companion.module.boot.test.ts` (extended) | still no chat-table writers reachable from the module — the egress scan walks the whole `v2/` tree, `v2/handlers/` included, and the DI check reads every constructor in a file |
| `companion-v2.privacy.test.ts` | no worker text in events, logs (spy on Logger) or Redis memory beyond pseudonymized text — the memory half while `AI_RAW_PII_ENABLED` is off; armed, memory holds raw text and events, logs and the replay cache still carry none ([ADR-0047](../../decisions/0047-lift-pii-restriction.md)) |
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

- **P1-OQ1 — `skills` writer — RESOLVED (owner ruling, 2026-09-28).** `contracts.md` §3 named
  `WorkerSkillsService.setWants`, an unwired seam that throws
  (`apps/api/src/match/worker-skills.service.ts:187`); no existing writer could add/delete a
  skill. **Ruling: build the missing writer, and keep skills edits on the WORKER-SIDE RÉSUMÉ
  ONLY.** T7 writes a deterministic résumé-only skills editor that appends/removes labels on the
  confirmed profile's résumé snapshot (`raw_profile.resume_profile.skills` when the container
  carries values, else `raw_profile.skills` / `raw_profile.skill_labels`) and triggers the
  ADR-0043 regeneration. NO `worker_skill` / `job_reach` / `worker_profiles.skills` writes, NO
  ADR-0030 canonicalization, no job-domain or role involvement — matching is deliberately
  untouched. A later re-extraction or confirm may restore an edited-away skill; accepted under
  the ruling. T1–T6 are unaffected.
- **P1-OQ2 — `EditableField` shape and catalogue scope — RESOLVED (owner rulings, 2026-09-29).**
  The spec referenced `EditableField` without defining it, and a card row carries one `value`.
  Rulings, now encoded in contracts §2.2/§3 and in `packages/ai-contracts/src/companion.ts` +
  `contracts.py`:
  **(a)** `EditableField = { section, field, ops }` — `field` is the LOGICAL name the model uses
  (e.g. `expected_salary`), mapped to the writer's DTO key by the catalogue; `ops` is the legal
  subset per field; the catalogue carries no worker text.
  **(b)** **Single-field adds only in Phase 1**: `add` is offered for skills, languages and
  occupations; employment and qualifications are edit/delete-only in chat (an add request gets the
  profile-screen line). Rationale: an employment/credential is inherently multi-field and O5 caps
  a message at 3 rows.
  **(c)** `preferences` catalogue reduced: `salary_period`, `commute_max_km` and the four
  `education_*` keys are removed; `expected_salary` is a single logical field written to
  `salary_expected_max` with `salary_expected_min` cleared.
  Recorded in contracts §2.2/§3; affects T7/T10 only.
