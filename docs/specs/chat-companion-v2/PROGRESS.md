# Chat Companion v2 — implementation progress

One entry per task, appended after the task's checks pass. Tasks come from
[`phase-1-router-and-edit-resume.md`](phase-1-router-and-edit-resume.md).

---

## T0 — 2026-09-28 18:12

- **Done:** Verified all six edit-catalogue writers (service + method, file path, input DTO /
  Zod schema, transaction support, existing events) and wrote the findings into
  `contracts.md` §3 (new "Verified" column) + new §3.1 detail table. Ticked T0 in the phase
  file and recorded the skills-writer blocker as **P1-OQ1** under "Open questions".
  - `docs/specs/chat-companion-v2/contracts.md`
  - `docs/specs/chat-companion-v2/phase-1-router-and-edit-resume.md`
  - `docs/specs/chat-companion-v2/PROGRESS.md` (new)
- **Checks:**
  - `pnpm lint` — 0 errors (3 pre-existing warnings, untouched files).
  - `pnpm typecheck` — 29/29 tasks successful.
  - `pnpm --filter @badabhai/api test` — 516 files passed, 21 skipped; 11,881 tests passed, 153 skipped.
  - `apps/ai-service`: `pytest -q` exit 0 (6,006 collected; one xfail as designed). The first run
    failed only because the console is cp1252 and the salary-attribution test prints Devanagari;
    `PYTHONIOENCODING=utf-8` fixes it. `ruff check .` — "All checks passed!".
- **Notes / decisions / surprises:**
  - `contracts.md` §3 is wrong for **skills**: `WorkerSkillsService.setWants`
    (`apps/api/src/match/worker-skills.service.ts:187`) is an unwired seam that throws. No
    existing writer can add/delete a wanted skill. The only working skills-edit path is
    `ExtractedCorrectionsService.correctExtracted` field `skills` (pinned session + profile id,
    full authored-list replace, canonical ids). **Blocked pending the P1-OQ1 ruling.**
  - The other five writers all open their OWN transaction in the repository and do NOT accept a
    `tx?: Database` handle today: employment, languages, qualifications, occupations. Preferences'
    repository (`WorkerAttributesRepository.upsertMany` / `deleteKeys`) already accepts `tx`.
  - Every writer emits its own event and enqueues a re-render/rebuild AFTER its write.
    `EventsService.emit` accepts `tx?: Database`, so the confirm flow's own events can join a
    transaction. `tx` params and moving side effects to after-commit are T7 work (per the spec,
    "add an optional tx param where needed"); no application code was changed in T0.
  - `ProfilesModule` exports only the repositories, not the five writer services;
    `WorkerSkillsService` is @Global via `MatchModule`. T7 either exports the services (additive)
    or provisions them in the companion module.
  - employment/languages/qualifications/occupations replace the WHOLE list; preferences patches
    keys. A single edit row needs read → mutate → replace for the four replace writers.
- **Next:** T1 (types), pending the P1-OQ1 answer — T1–T6 do not depend on the skills decision.

---

## T0 follow-up — P1-OQ1 ruling — 2026-09-28 18:44

- **Done:** Owner ruled on the skills writer. Updated `contracts.md` §3 (skills row + T7 notes)
  and the phase file's Open questions with the resolution. No code changed.
  - `docs/specs/chat-companion-v2/contracts.md`
  - `docs/specs/chat-companion-v2/phase-1-router-and-edit-resume.md`
  - `docs/specs/chat-companion-v2/PROGRESS.md`
- **Ruling (verbatim answers):** (1) "Build the missing writer." (2) On scope: "Don't think about
  skills related to job posting/matching/domains/roles right now only the worker side app and
  profiling matters. And only focus on worker side of the app for now." (3) On removal effect:
  "Résumé only."
  Concretely, T7 builds a deterministic résumé-only skills editor: append/remove labels on the
  confirmed profile's résumé snapshot (`raw_profile.resume_profile.skills` when the container
  carries values, else `raw_profile.skills` / `raw_profile.skill_labels`), then regenerate
  (ADR-0043, trigger `chat_edit`). Matching stores (`worker_skill`, `job_reach`,
  `worker_profiles.skills`) are NOT written; no ADR-0030 canonicalization and no job-domain
  lookup. A later re-extraction/confirm may restore an edited-away skill — accepted.
- **Checks:** docs-only; no code touched. Re-ran nothing beyond T0's green gates.
- **Notes / decisions / surprises:** `worker_profiles.skills` (the canonical column) feeds
  matching derivation (`WorkerSkillsRepository.findLatestProfileSignals`), so it must stay
  untouched to honour "résumé only". The résumé prints from `raw_profile` JSON on both render
  paths; the container path prefers `resume_profile.skills`, the legacy path merges
  `skills` + `skill_labels`.
- **Next:** T1 (types).

---

## T1 — 2026-09-28 18:52

- **Done:** Added the v2 vocabularies to `packages/types/src/index.ts`, directly beside the ADR-0044
  companion block, exactly as contracts §1 names them:
  `COMPANION_V2_INTENTS` (+ `CompanionV2Intent`), `COMPANION_V2_INTENT_SOURCES`
  (+ `CompanionV2IntentSource`), `COMPANION_V2_OUTCOMES` (+ `CompanionV2Outcome`).
  No tests added (the package ships `--passWithNoTests` and has no test files; the sets are pinned
  by the T3 event-schema enums and the A1 Pydantic mirror).
  - `packages/types/src/index.ts`
- **Checks:**
  - `pnpm --filter @badabhai/types test` — no test files, exit 0; `typecheck` + `build` clean.
  - `pnpm lint` — 0 errors (same 3 pre-existing warnings).
  - `pnpm typecheck` — 29/29 tasks.
  - `pnpm --filter @badabhai/api test` — 516 files / 11,881 tests passed (153 skipped).
  - `apps/ai-service`: `pytest -q` exit 0; `ruff check .` clean.
- **Notes / decisions / surprises:** None. Plain `as const` (not frozen) to match the adjacent
  ADR-0044 block and the contracts snippet; freezing can be added when the event-schema enum is
  built if wanted.
- **Next:** T2 (config flags + knobs).

---

## T2 — 2026-09-28 18:56

- **Done:** Added every v2 flag and knob from contracts §6 to `packages/config/src/server.ts`, a
  `fractionFromString` helper (empty-string-tolerant 0..1 float, the `positiveIntFromString`
  rationale) to `shared.ts`, a config test block (defaults, empty-string tolerance, 0..1 bounds),
  and a "Companion v2 (ADR-0046)" bullet to `docs/environment-variables.md`. All five flags default
  off; off is v1 byte-for-byte. `.env.example` / compose / `ci.yml` are DevOps scope and not touched.
  - `packages/config/src/server.ts`
  - `packages/config/src/shared.ts`
  - `packages/config/src/config.test.ts`
  - `docs/environment-variables.md`
- **Checks:**
  - `pnpm --filter @badabhai/config test` — 9 files / 186 tests passed (3 new v2 tests).
  - `pnpm lint` — 0 errors (same 3 pre-existing warnings).
  - `pnpm typecheck` — 29/29 tasks.
  - `pnpm --filter @badabhai/api test` — 11,881 passed / 153 skipped.
  - `apps/ai-service`: `pytest -q` exit 0; `ruff check .` clean.
- **Notes / decisions / surprises:** `fractionFromString` lives in `shared.ts` beside its integer
  sibling rather than as an inline preprocess in `server.ts`, so the empty-string rule and its
  rationale stay in one place for the next fraction knob.
- **Next:** T3 (event schemas + registry).

---

## T3 — 2026-09-29 10:30

- **Done:** Added the Phase 1 events.
  - `packages/types/src/index.ts`: `COMPANION_V2_EDIT_SECTIONS`, `COMPANION_V2_UNSUPPORTED_EDIT_TARGETS`,
    `COMPANION_V2_CONFIDENCE_BUCKETS` (+ types). These are the closed sets the edit catalogue (T7),
    the AI-service edit-parse contract (A1) and the event spine all pin, so they live in the shared
    vocabulary package rather than in any one consumer.
  - `packages/event-schema/src/payloads.ts`: `ChatCompanionTurnServedV2Payload` (v1 fields restated
    + `intent_source`, nullable `v2_intent`, nullable `confidence_bucket`, `outcome`; v1's
    jobs refine repeated), `ChatCompanionEditProposedPayload`, `ChatCompanionEditConfirmedPayload`,
    `ChatCompanionEditCancelledPayload` — all `.strict()`.
  - `packages/event-schema/src/registry.ts`: four new entries appended at the tail, domain `chat`.
    The turn's v2 is `chat.companion_turn_served_v2` (`version: 2`) — the house
    `feed.shown_v2` / `profile.viewed_v2` / `resume.edited_v2` new-name pattern, because
    `validateEvent` allows one version per name and v1 must keep its definition + emitter.
  - `packages/event-schema/src/chat-companion-v2.test.ts` (new, 17 tests): registration, closed-set
    membership, the jobs refine, `.strict()` text-smuggling rejection for all four, version-
    mismatch rejection, and v1-untouched locks.
  - `packages/event-schema/src/event-schema.test.ts`: `VERSIONED_PAYLOADS` +=
    `chat.companion_turn_served_v2: 2`; registry count 208 → 212 + the four `isEventName` checks.
  - `docs/specs/chat-companion-v2/contracts.md` §4: one-line registry-key note.
- **Checks:**
  - `pnpm --filter @badabhai/event-schema test` — 6 files / 375 tests passed.
  - `pnpm lint` — 0 errors (same 3 pre-existing warnings); fixed one unused-var error in the new test.
  - `pnpm typecheck` — 29/29 tasks.
  - `pnpm --filter @badabhai/api test` — 11,881 passed / 153 skipped.
  - `apps/ai-service`: `pytest -q` exit 0; `ruff check .` clean.
- **Notes / decisions / surprises:** `@badabhai/types` must be built (`pnpm --filter @badabhai/types
  build`) before running event-schema tests when its vocabulary changes — the first test run failed
  with `z.enum(undefined)` because the package resolves through `dist/`. Phase 2/3 events
  (`chat.companion_faltu_strike`, `chat.companion_career_answered`) are NOT registered in Phase 1.
- **Next:** T4 (AI client `companionClassify` / `companionEditParse`).

---

## A1 — 2026-09-29 11:13

- **Done:** The classify/edit-parse contracts, mirrored and pinned:
  - `packages/types/src/index.ts`: `COMPANION_V2_EDIT_OPS` (+ type) beside the v2 vocabularies,
    because the AI contract and T7's catalogue must name the same three ops.
  - `apps/ai-service/app/contracts.py`: `CompanionV2Intent` / `EditSection` / `EditOp` /
    `UnsupportedEditTarget` / `CompanionMemoryRole` + `CompanionRecentTurn`, `EditableField`,
    `CompanionEditSnapshotRow`, `CompanionEditRow`, `CompanionClassifyInput`,
    `CompanionClassifyOutput`, `CompanionEditParseInput`, `CompanionEditParseOutput`.
  - `packages/ai-contracts/src/companion.ts` (new) + barrel exports in `index.ts`.
  - `packages/ai-contracts/src/__fixtures__/companion.keys.json` (new, 8 models).
  - `ai-contracts.test.ts`: 8-key parity block + closure + enum-source check + no-PII + caps.
  - `tests/test_contract_parity.py`: model_fields vs the same fixture, enum values read from
    `packages/types/src/index.ts`, boundary behaviour (text/field/ref/max_rows), defaults,
    no-PII. The old `_zod_string_union` now delegates to a generic `_string_union_in`.
  - Docs: contracts §2.2 defines `EditableField`; §3 rows updated (edit/delete-only for
    employment & qualifications, reduced preferences, `expected_salary` → `salary_expected_max`);
    phase file P1-OQ2 records all three 2026-09-29 rulings.
- **Checks:**
  - `pnpm --filter @badabhai/ai-contracts test` — 136 passed (8 new parity tests).
  - `pnpm --filter @badabhai/types test` — no test files, exit 0.
  - `pnpm lint` 0 errors (same 3 pre-existing warnings) · `pnpm typecheck` 29/29.
  - `pnpm --filter @badabhai/api test` — 11,881 passed / 153 skipped.
  - ai-service `pytest` exit 0 · `ruff check .` clean.
- **Notes / decisions / surprises:** Zod `.default(null)` on the edit row's `ref`/`field`/`value`
  mirrors the Pydantic `= None` defaults: omission is legal at the contract, and the API drops a
  malformed row instead of failing the transport; `op`/`section` stay required. `EditableField.ops`
  is the only place `add` legality per section is expressible, so the catalogue is what enforces
  "single-field adds only" at prompt time (the DTO schema is the second wall in T7).
- **Next:** A2 (companion module + endpoints in the AI service).

---

## A2 — 2026-09-29 11:32

- **Done:** The companion module and its two routes.
  - `app/companion/__init__.py`, `prompts.py` (system prompts + message builders; catalogue and
    current values rendered as compact JSON, worker text labelled data),
    `classify.py` (fail-closed output parser + memory-turn masking), `edit_parse.py` (per-row
    validation, row cap, unsupported filtering, snapshot masking).
  - `app/routers/companion.py`: `POST /companion/classify`, `POST /companion/edit-parse`.
    Pseudonymize FIRST; blocked → `{intent:unclear, confidence:0, blocked:true}` / empty proposal.
    Deterministic mock responses. Registered in `main.py`.
  - `app/ai/model_config.py`: `companion_classify` / `companion_edit_parse` routes (cheap, JSON
    mode, temperature 0.0, 64/512-token budgets). REQUIRED for A2 to be green — `router.run`
    raises on an unregistered task, and two guard tests (`test_ai_instruments`,
    `test_task_type_ledger_parity`) pin that. A3's remaining scope is the prompt registry +
    route tests.
  - `packages/event-schema/src/payloads.ts`: `aiTaskType` gained both members (additive).
  - `apps/api/src/admin/admin-dashboard.dto.ts`: both classified `false` (post-confirmation
    spend, same side as `work_history_polish`).
  - `apps/api/src/ai/ai-cost-coverage.test.ts`: both added to `KNOWN_UNLEDGERED` — apps/api has
    no emitter yet; **remove them in the change that wires it (T4/T6)**.
  - `tests/test_service_auth.py`: POST surface 17 → 19.
  - `tests/test_companion.py` (new, 18 tests): blocked-before-router, masking of message/memory/
    snapshot, fence tolerance, fail-closed output, row cap and per-row drops, mock validity,
    prompt content, route registration.
- **Checks:**
  - ai-service `pytest` exit 0 (18 new) · `ruff check .` clean.
  - `pnpm --filter @badabhai/event-schema test` — 375 passed.
  - `pnpm --filter @badabhai/api test` — 11,881 passed / 153 skipped.
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29.
- **Notes / decisions / surprises:** Every model input is masked, not just the message — memory
  turns (blocked ones dropped) and snapshot values (blocked ones nulled). `blocked` on the
  classify output is forced False after parsing: it is the pseudonymizer's fact, never the
  model's. The `KNOWN_UNLEDGERED` entries are a debt marker for T4.
- **Next:** A3 (prompt registry + route tests for the two new tasks).

---

## A3 — 2026-09-29 11:40

- **Done:** Prompts in the registry + route/trace naming + tests (the route shapes themselves
  landed with A2, see its entry).
  - `app/ai/prompt_registry.py`: `COMPANION_CLASSIFY` / `COMPANION_EDIT_PARSE` names beside the
    others; both registered in `install_default_prompts` (docstring corrected — it still said
    "exactly three").
  - `app/ai/langfuse_tracing.py`: `_TASK_TRACE` entries
    (`classify-companion-message` / `parse-companion-edit`, workflow `companion`) so the traces
    are named and grouped, not the `other` fallback.
  - `app/companion/prompts.py`: local name constants removed (single source is now the registry);
    `routers/companion.py` resolves through `prompt_registry`.
  - `tests/test_companion_routes.py` (new, 5 tests): route shapes cheap/JSON/temp-0, budgets,
    cheap-model resolution, registration + local version, version-moves-with-text.
- **Checks:**
  - ai-service `pytest` exit 0 (5 new) · `ruff check .` clean.
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29 · `pnpm --filter @badabhai/api test` 11,881
    passed / 153 skipped.
- **Notes / decisions / surprises:** The registered text equals the route's fallback constant by
  construction (no interpolation), so a Langfuse-managed prompt is the ONLY way they can differ —
  which is what makes the version record meaningful.
- **Next:** T4 (`AiService.companionClassify` / `companionEditParse`, 3 s / 6 s timeouts).

---

## Merge note — 2026-09-29 12:0x

- `feat/companion-v2-phase1` was retargeted to `main` and squash-merged as **#1816**
  (`15bc654d`), carrying T0–T3 + A1–A3 and the ADR-0046/spec docs. #1814 was closed as
  superseded by #1816.
- Per CLAUDE.md §14, the merged branch is DEAD. All remaining Phase 1 work continues on
  **`feat/companion-v2-phase1-cont`**, cut from fresh `main` (`15bc654d`).

---

## T4 — 2026-09-29 12:17

- **Done:** `apps/api/src/ai/ai.service.ts`: `companionClassify` (3 s) and
  `companionEditParse` (6 s), following `jobPostingChatRespond`'s `this.post(path, input,
  OutputSchema, timeoutMs, ctx)` pattern — null on every failure, caller treats it as
  `unclear` / no card. Both schemas and types imported from `@badabhai/ai-contracts`.
  Tests in `ai.service.test.ts` (+7): URL/body per route, schema-miss → null, unreachable →
  null, the two abort budgets pinned on the AbortSignal with fake timers, and both methods
  added to the BL-19 ctx-forwarding block (5 → 7 calls in the optional-ctx test).
  - `apps/api/src/ai/ai.service.ts`
  - `apps/api/src/ai/ai.service.test.ts`
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 11,888 passed / 153 skipped (7 new).
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29.
  - ai-service `pytest` exit 0 · `ruff check .` clean.
- **Notes / decisions / surprises:** The `KNOWN_UNLEDGERED` entries for the two tasks stay
  until T6/T7 wire the emitter; the removal is part of that change (the coverage test enforces
  the pairing).
- **Next:** T5 (Redis stores: `companion-memory.store.ts`, `edit-proposal.store.ts`).

---

## T5 — 2026-09-29 12:27

- **Done:** The two Redis-only stores (contracts §7), reusing BullMQ's connection via
  `RESUME_RENDER_QUEUE` (`ResumeRateLimit` / `AdminMfaSecretStore` precedent; the module now
  registers the queue for its connection only — nothing enqueues to it).
  - `v2/companion-memory.store.ts`: `companion:v2:mem:{workerId}` list, `read` (tail, oldest
    first, per-entry schema validation, fail-soft `[]`), `append` (RPUSH + LTRIM to
    `MEMORY_TURNS` + EXPIRE `MEMORY_TTL_SECONDS`, best-effort). Never logs text.
  - `v2/edit-proposal.store.ts`: `companion:v2:proposal:{workerId}` JSON, one active card per
    worker (SET replaces), `save` returns boolean (false → no card offered, contracts §7),
    `load` (Zod-validated; unreadable/off-contract = absent), `delete` best-effort. The stored
    row shape (`StoredEditProposal{Row}Schema`) is what T7 applies: `row_id`, section/op/field/
    value, captured `before` for the stale check, section label, and the server-resolved
    `target` (never a DB id on the wire).
  - `chat-companion.module.ts`: queue registration + both providers.
  - `chat-companion.module.boot.test.ts` EXTENDED (README rule 3): five providers, `AiModule`
    pinned @Global with `AiService` exported (T6's only model path), and the egress guard now
    scans `v2/` — the five original bans hold for both generations, v1 keeps its no-AI rule,
    and a new v2 ban forbids any direct fetch/SDK call (model calls only via `AiService`).
  - Tests: `companion-memory.store.test.ts` (8), `edit-proposal.store.test.ts` (12) — caps,
    TTLs, key namespace, replace-not-append, schema-miss = absent, every fail-soft branch, and
    "no proposed value in a log line".
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 11,909 passed / 153 skipped (20 new).
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29.
  - ai-service `pytest` exit 0 · `ruff check .` clean.
- **Notes / decisions / surprises:** `save` is the one non-fail-soft operation on purpose — the
  caller must know not to show a card it cannot later apply. `StoredEditProposal.target` is a
  `Record<string, string | number> | null` so T7 can resolve section-specific identities
  (employment id, language slug, list position) without this store knowing any writer's DTO.
- **Next:** T6 (orchestrator + handlers; v1-first, model only on a miss).

---

## Order note — dependency inversion (2026-09-29 12:35)

The checklist order T6→T7→T8→T9→T10 is dependency-INVERTED: T6's handlers serve T10's copy and
call T7's edit service; T7 needs T8's wire field, T9's `chat_edit` trigger and T10's copy; T8's
routes call T7's service. Executing in checklist order would force either red intermediate
commits or one giant commit. Continuing in dependency order — **T10 → T9 → T7 → T8 → T6 →
A4/tests** — with each task still its own commit. PROGRESS records the actual order.

---

## T10 — 2026-09-29 12:35

- **Done:** The v2 copy and task-chip keys.
  - `companion-replies.ts`: the ten P1 `CopyPair`s (V2_PHASE_OFF, V2_JOBS_DEFERRED, V2_CLARIFY,
    V2_EDIT_CARD_INTRO, V2_EDIT_NONE, V2_EDIT_IDENTITY, V2_EDIT_DONE, V2_EDIT_DONE_CAPPED,
    V2_EDIT_CANCELLED, V2_EDIT_STALE), all in `ALL_COPY_PAIRS`.
  - `companion-task-keys.ts` (new): `companion_task:edit_resume` / `:new_resume` / `:career_talk`
    + labels. **Deviation from the spec's file:** NOT in `companion-keys.ts` — the worker app's
    `chat_companion_keys_test.dart` reads that file and pins the key set to exactly the four v1
    keys, so adding these there reddens the Flutter suite before F5 ships. A separate backend file
    keeps every existing suite green; F5 points its parity test here when it mirrors them.
  - Tests: replies test scans the ten new pairs + three chip labels (persona/twin rules); new
    `companion-task-keys.test.ts` (prefix, collision-freedom, reserved prefixes).
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 11,975 passed / 153 skipped.
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29.
  - ai-service `pytest` exit 0 · `ruff check .` clean.
- **Notes / decisions / surprises:** Faltu/career refusal copy is P2/P3 and deliberately NOT
  authored yet (one phase per PR). The `companion_task:jobs` row in contracts §5.3 is served by
  v1's existing `companion_new_jobs` chip, so no second jobs key exists.
- **Next:** T9 (`chat_edit` trigger + migration 0130).

---

## T9 — 2026-09-29 12:47

- **Done:** The `chat_edit` generation trigger end to end.
  - `packages/types`: `RESUME_GENERATION_TRIGGERS` += `chat_edit` (ADR-0046 O6).
  - `apps/api/src/resume/resume.dto.ts`: `SystemResumeTrigger` += `chat_edit`.
  - `apps/api/src/resume/resume.service.ts`: metered like `chat_update_accepted` — the
    per-worker daily cap applies, and a queue retry does not re-charge (the `retry` comment
    updated).
  - `packages/db/src/schema/profile.ts`: CHECK widened; `pnpm db:generate` produced migration
    **0130**, renamed `0130_resume_generation_trigger_chat_edit` (journal tag updated) and given
    the house header (deploy order = before the FLAG; lock_timeout; rollback restores the
    0125 list). Snapshot `0130_snapshot.json` written by drizzle.
  - `packages/db/src/migration-0130-resume-generation-trigger-chat-edit.test.ts` (new, 11
    tests): additive-only, frozen vocabulary, NULL tolerance, the LIVE-model tripwire against
    `RESUME_GENERATION_TRIGGERS`, snapshot lineage, header, journal.
  - `packages/db/src/migration-0125-resume-history.test.ts`: its trigger assertion now pins the
    FROZEN 0125 literal (it compared the migration to the live constant, which made the
    migration un-widenable; 0130's test owns live agreement).
  - `packages/db/src/schema-contract.ts`: `0130-generated-resumes-generation-trigger-chat-edit`
    (`kind: "constraint"`).
  - `MIGRATIONS.md`: the reserved `0130` row rewritten as shipped (apply-before-flag, locks,
    rollback, verify-by-`pg_get_constraintdef`).
  - `resume.service.test.ts`: +1 test (chat_edit metered, labelled on the saved row, retry free).
- **Checks:**
  - `pnpm --filter @badabhai/db test` — 130 files / 2,684 passed.
  - `pnpm --filter @badabhai/event-schema test` — 375 passed.
  - `pnpm --filter @badabhai/api test` — 11,976 passed / 153 skipped.
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29 · ai-service `pytest` exit 0 + `ruff` clean.
- **Notes / decisions / surprises:** `@badabhai/types` must be REBUILT before db/api tests when
  its vocabularies change (packages resolve through `dist/`; the same footgun recorded at T3).
  Migration mechanics: `db:generate` → rename tag → update `_journal.json` → header → test.
- **Next:** T7 (edit catalogue + service; needs T8's `edit_proposal` wire field, which lands
  with it as the strict turn schema requires it).

---

## T7 (part 1) — additive tx support — 2026-09-29 13:05

- **Done:** Every section writer the catalogue reaches can now JOIN the caller's transaction
  (owner-approved strategy: additive `tx?: Database`, keeping each writer's logic in its own
  service):
  - `WorkerEmploymentRepository.replaceForWorker` (+ `findOwnedVoiceNoteIds`) and
    `WorkerEmploymentService.replaceForWorker`;
  - `WorkerLanguagesRepository.replaceForWorker` / `WorkerLanguagesService.replaceForWorker`;
  - `WorkerQualificationsRepository.replaceForWorker` / `WorkerQualificationsService.replaceForWorker`;
  - `WorkerOccupationsRepository.replaceForWorker` / `WorkerOccupationsService.replaceForWorker`;
  - `WorkerAttributesRepository.loadKeys` (+ the already-tx `upsertMany`/`deleteKeys`) /
    `WorkerPreferencesService.setForWorker`.
  On a joined transaction each service: runs its repo call on the caller's tx, emits its event
  WITH the tx (atomic with the write), and SKIPS its own re-render (or, for occupations, the
  matching rebuild) — the companion regenerates once after commit (O6), and a render enqueued
  inside a transaction that later rolls back would describe a history that never existed.
  Arities are preserved (`tx: undefined` is never passed), so every existing caller's call
  shape and every writer test stay byte-identical.
  - `packages/db/src/client.ts`: the `Database` docblock records the tx convention (a drizzle
    transaction handle is typed `Database` here; the cast is contained at the one place the
    callback meets the client — the `AdminActionsRepository.withTransaction` precedent).
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 11,976 passed / 153 skipped (all writer suites green).
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29.
- **Notes / decisions / surprises:** `this.db.transaction((inner) => run(inner as unknown as
  Database))` is the localized cast; `run` only ever touches the query API. The five writer
  suites (239 tests) all pass unchanged.
- **Next:** T7 part 2 — `v2/edit-catalogue.ts` + `v2/companion-edit.service.ts` (+ the
  `edit_proposal` wire field).

---

## T7 (part 2) — edit catalogue + service — 2026-09-29 14:00

- **Done:** The edit path, end to end.
  - `chat-companion.dto.ts`: `edit_proposal` / `read_aloud` / `cooldown_until` on
    `CompanionTurnSchema` (the T8 wire field, landed here because the strict turn schema needs
    it) + `ConfirmEditSchema` / `CancelEditSchema` (used by T8's routes).
  - `v2/edit-catalogue.ts`: the closed catalogue (fields/ops per the owner rulings), section
    labels, per-field normalisation against the same vocabularies/bounds the writers' DTOs
    enforce, the O17 placeholder-token screen, and a PII screen on skill labels.
  - `v2/companion-edit.service.ts`: snapshot (per-section fail-soft, refs minted server-side,
    targets never on the wire), deterministic row validation (catalogue/op/ref/value/token/
    no-op), proposal store + card turn, stale check, confirm applying every selected row through
    the section writers on ONE transaction, cancel, `chat_edit` regeneration with the daily cap,
    and the three edit events (deduped by proposal id).
  - `v2/companion-v2-compose.ts`: v2 turn builders + task chips (enabled phases only).
  - `profiles.repository.ts`: `setResumeSkillLabels` — the résumé-ONLY skills writer (raw-profile
    snapshot only; never the matching column/`worker_skill`/`job_reach`).
  - `companion-replies.ts`: `V2_EDIT_UNAVAILABLE` (contracts §7's store-failure line).
  - `chat-companion.module.ts`: the edit service + its own instances of the five writers and the
    repos they need (leaf preserved; see the module docblock).
  - Tests: `companion-edit.fake.ts` harness + `companion-edit.validate.test.ts` (14),
    `companion-edit.confirm.test.ts` (9), `companion-edit.no-identity.test.ts` (4).
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 12,011 passed / 153 skipped.
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29 · ai-service `pytest` exit 0 + `ruff` clean.
- **Notes / decisions / surprises:** identity/contact rows are ALSO inferred into `unsupported`
  (a model row aimed at them serves `V2_EDIT_IDENTITY` even if the model forgot the hint). A
  newly added language gets `can_speak: true` (the writer requires ≥1 ability; speaking is the
  honest default). An occupations edit rebuilds matching AFTER commit; every writer skips its own
  re-render on a joined transaction and the companion regenerates once (trigger `chat_edit`).
  List preferences are member-level add/delete; `availability` is three scalar sub-fields merged
  into the stored object (owner ruling 2026-09-29).
- **Next:** T8 (controller routes for confirm/cancel; DTOs landed with T7).

---

## Merge note — 2026-09-29 14:1x

- `feat/companion-v2-phase1-cont` was squash-merged as **#1817** (`66091f66`), carrying
  T4, T5, T7, T9 and T10. CI was fully green before the merge (Node, migration drift/sequence,
  SAST, E2E, image gates), and the artifacts were verified on `origin/main` itself.
- Per CLAUDE.md §14 the merged branch is DEAD. The REMAINING work — T8 (confirm/cancel routes),
  T6 (orchestrator + handlers) and A4 + the phase §3 tests — continues on
  **`feat/companion-v2-phase1-tail`**, cut from fresh `main` (`66091f66`).

---

## T8 — 2026-09-29 14:15

- **Done:** The two edit-card routes (contracts §5.2).
  - `chat-companion.controller.ts`: `POST /chat/companion/edits/:proposalId/confirm` (200 turn ·
    404 unknown/expired/other worker's · 409 `{mode:"interview"}` · 409 `{reason:"stale"}`) and
    `POST /chat/companion/edits/:proposalId/cancel` (200 turn · 404). HTTP only; the proposal id
    is param-validated as a uuid; both are `no-store`.
  - `chat-companion.service.ts`: `confirmEdit` / `cancelEdit` — the flags gate FIRST (off ⇒ 404,
    so a card left in Redis from a disabled flag is never applied), then the policy (interview ⇒
    409), then the edit service; the resulting turn passes the strict outbound schema with the
    v1 fallback on a shape miss (`checkedTurn`).
  - DTOs (`ConfirmEditSchema` / `CancelEditSchema`, `edit_proposal` on `CompanionTurnSchema`)
    landed with T7 as recorded there.
  - Tests: controller (+6: turn, interview, stale, 404, cancel, no-store loop extended) and
    service (+5: flags-off, interview, applied, stale, cancel/unknown). The "companion's reach"
    arity test updated to 8 with the reason the eighth collaborator is inert.
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 12,021 passed / 153 skipped.
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29 · ai-service `pytest` exit 0 + `ruff` clean.
- **Notes / decisions / surprises:** The flags-off 404 is the fail-closed half of O4: turning
  the v2 flags off must never leave a confirmable card behind.
- **Next:** T6 (orchestrator + handlers; v1-first, model only on a miss).

---

## T6 — 2026-09-29 14:25

- **Done:** The v2 turn pipeline and its delegation.
  - `v2/companion-v2.orchestrator.ts`: pseudonymize FIRST (blocked/unreachable ⇒ clarify, no
    classifier call, no memory), read memory (last 2 turns), classify, route through the
    registry, append the pseudonymized pair, emit `chat.companion_turn_served_v2` (deduped by
    `submission_id`). `intent` stays the v1 vocabulary (`fallback`); the truth is in
    `v2_intent`/`outcome`. Confidence buckets: lt50 < 0.5, 50_70 < 0.7, 70_90 < 0.9, else gte90.
  - `v2/handlers/*`: `handler.ts` (interface), `edit-resume.handler.ts`, `fixed-line.handlers.ts`
    (jobs-deferred / phase-off / unclear) and `registry.ts` (the ONE place the phase flags are
    read). `CompanionEditService.propose` now returns `{ turn, outcome }` so the event records
    the real outcome instead of inferring it from copy.
  - `ChatCompanionService.message`: delegates on a v1 miss **and only on v1's `fallback`
    intent** — every named v1 intent and every menu alias keeps the v1 branch, zero model calls.
  - Module + boot test updated (six new providers); the service's reach arity is now 9.
  - Tests: `companion-v2.orchestrator.test.ts` (8: every intent, all four clarify paths, memory
    pair, masked text, event payload validated against the merged schema),
    `companion-v2.v1-first.test.ts` (11: every v1 fixture, no v2/model call),
    `companion-v2.flag-off.test.ts` (9: v2 off ⇒ v1 event/turn byte-for-byte, edit routes 404).
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 12,049 passed / 153 skipped.
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29 · ai-service `pytest` exit 0 + `ruff` clean.
- **Notes / decisions / surprises:** the v1-miss definition is v1's `fallback` intent; treating
  every non-menu resolution as a miss (the first cut) sent digest/jobs/applied/guarantee to the
  classifier — caught by `companion-v2.v1-first.test.ts`. The API pre-masks via
  `AiService.pseudonymize` so memory only ever holds pseudonymized text (the classify endpoint
  re-masks idempotently).
- **Next:** A4 (evals) + the remaining §3 tests (privacy, persona extension already covered).

---

## A4 — 2026-09-29 14:36

- **Done:** The evals (and a real bug they caught).
  - `app/companion/eval_classify_gold.py`: **158** labelled lines across all six intents (Latin
    Hinglish, Devanagari, English, typos, voice-transcript shapes), `evaluate()` scoring accuracy
    + `edit_resume` precision, thresholds 0.90 / 0.95.
  - `app/companion/eval_edit_parse_gold.py`: **74** cases across all six sections, all three ops,
    multi-row (incl. a three-row) messages, against a frozen catalogue/snapshot fixture;
    `evaluate()` scores exact-row accuracy (0.90) and flags any out-of-catalogue row.
  - `app/companion/eval_cli.py`: the STAGING gate (`--classify` / `--edit-parse --base-url`),
    exits non-zero below the §4 bars.
  - `tests/companion/test_companion_evals.py` (9): set size/coverage, scorer capability (a
    constant predictor fails; an identity row is caught), containment, and a TS↔gold catalogue
    parity check read from `edit-catalogue.ts` (so the fixture cannot drift).
  - **Bug caught by the eval:** the catalogue allowed `delete` on NO employment/qualification
    field, so those deletes were silently dropped. Fixed in its own commit (`a9a2fd64`) with a
    pinning API test.
- **Checks:**
  - ai-service `pytest` exit 0 (9 new) · `ruff check .` clean.
  - `pnpm --filter @badabhai/api test` — 12,050 passed / 153 skipped.
  - `pnpm lint` 0 errors · `pnpm typecheck` 29/29.
- **Notes / decisions / surprises:** CI cannot score a model (mock-only), so the deterministic
  half gates the SET and the SCORER while the CLI gates the model on staging; that mirrors the
  canonicalization eval's split.
- **Next:** the last §3 test — `companion-v2.privacy.test.ts` — then the phase checklist is done.
