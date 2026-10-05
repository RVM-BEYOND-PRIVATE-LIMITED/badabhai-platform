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

---

## Tests (spec §3) — 2026-09-29 14:40

- **Done:** The last named test and the phase status.
  - `v2/companion-v2.privacy.test.ts` (5): the raw worker text appears in no event payload, no
    log line (real Logger spies on the classifier-failure and spine-failure paths) and never
    reaches the classifier or Redis memory — only the gateway's masked output does; a blocked
    message is never classified or stored.
  - README phase table: Phase 1 marked **Built, flags off**.
  - The full §3 test list is now present: flag-off, v1-first, orchestrator, edit validate /
    confirm / no-identity, module boot (extended), privacy, replies (extended), event-schema
    tests, and the ai-service parity/endpoint/eval tests.
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 12,055 passed / 153 skipped.
  - ai-service `pytest` exit 0 · `ruff check .` clean · `pnpm lint` 0 errors · typecheck 29/29.
- **Next:** owner review / merge of the tail branch; then the Frontend (#1818) and DevOps items,
  and the staging eval run before any flag-ON.

---

## Tail PR #1819 — 2026-09-29 14:55

- **Done:** Two CI follow-ups from the first run of #1819.
  - SAST (semgrep, blocking): the eval CLI's `urllib.request.urlopen` tripped
    `dynamic-urllib-use-detected`. Replaced with `httpx` (already the sanctioned transport per
    `requirements.txt`) exactly like the canonicalization eval — no suppression comment.
  - Same edit fixed a real bug the SAST review surfaced: the CLI sent
    `authorization: Bearer $AI_INTERNAL_TOKEN`, but the service enforces the TD67
    `x-ai-internal-token` header from settings — an armed staging service would have 401'd into
    all-miss noise. Now mirrors `get_settings().ai_internal_token`.
- **Checks:** PR #1819 fully green — Node, AI service, Image gate, E2E, SAST, ci-required.

---

## DevOps — 2026-09-29 15:30

- **Done:** The two phase-1 DevOps items, on `feat/companion-v2-deploy-and-cost`.
  - **Deploy chain** (`5c5886fd`): all five v2 phase flags bridged — `docker-compose.staging.yml`
    `${VAR:-false}` pass-throughs, `ci.yml` `env:` + `envs:`, `.env.example`, and the
    `deploy-workflow-taxonomy.guard.test.ts` cases pinning each hop and every default. The
    KNOBS are deliberately NOT bridged (reviewed defaults; changing one is a compose diff).
    `docs/environment-variables.md` no longer says this is pending.
  - **Cost ledger (this commit):** the A2/A4-era gap is closed. Both ai-service endpoints now
    return `ai_metadata` (`router.run`'s `_meta` was discarded — the #745/#738 shape) on
    `CompanionClassifyOutput` / `CompanionEditParseOutput` (Python + Zod + golden fixture,
    parity green), and the API records it through `AiCostRecorder` in
    `CompanionV2Orchestrator.handleMessage` (`companion_classify`) and
    `CompanionEditService.propose` (`companion_edit_parse`) — before any branch can return,
    null meta no-op'ing as everywhere else. Both left `KNOWN_UNLEDGERED` in the SAME change,
    and the coverage test's pinned emitted set now carries them.
  - **Dashboard:** nothing to build — `platform_ai_cost_totals` accrues per (provider,
    task_type) and the admin dashboard's `by_task_type` buckets are raw, so companion spend
    renders automatically (its panel de-snakes unknown labels). `PROFILING_TASK_TYPE_KEYS`
    already classified both as non-profiling.
  - **Alert:** the per-call `cost_alert` flag now rides companion `ai.cost_recorded` events;
    threshold `ai_cost_alert_profile_inr` is owner config, and no push alerting exists in the
    repo (`docs/observability-runbook.md`). O12's "not capped" holds — nothing was added.
- **Checks:**
  - ai-service `pytest` 6,048 passed / 4 skipped · `ruff` clean.
  - `pnpm --filter @badabhai/api test` 12,066 passed / 153 skipped · lint 0 errors ·
    typecheck 29/29 · `@badabhai/ai-contracts` 136 passed.
- **Notes / decisions / surprises:** the checklist's "alert on `ai_jobs`" is the ledger
  (event + totals), not an `ai_jobs` row — inline calls have none by #745's design; recorded
  in the phase file so the wording cannot be re-read as a gap.
- **Next:** the tail PR for this branch; then the Frontend items (#1818) and the staging eval
  run (which now also needs `AI_REAL_CALL_TASKS` widened on the box to name the two companion
  tasks — an env action, noted in compose and the phase file).

---

## Phase 2 — New résumé + Faltu — 2026-09-29 17:05

- **Done:** N1–N6 + A1, on `feat/companion-v2-phase2-new-resume-faltu`, one commit per task.
  - **N1** (`c95edfde`): `new-resume.handler.ts` — consent-gated (`resume_generation`, fail
    closed to the v1 FALLBACK + chips), serving the résumé menu's redo turn verbatim through a
    new `v2MenuTurn` that mirrors v1's private `menuTurn` field-for-field. `resolveResumeMenu`
    takes TEXT, not a key — the handler calls it with `RESUME_MENU_REDO_LABEL`, the same call
    the menu makes for its own chip (the phase file's "with RESUME_MENU_REDO_KEY" was loose
    wording). `ConsentModule` is now imported by the leaf (no chat edge).
  - **N2** (`bdc88f34`): `faltu.store.ts` — `countStrike` (INCR + 24 h TTL on the first),
    `startCooldown` (SET EX), `cooldownUntil` (PTTL, positive TTL only). FAILS OPEN on Redis,
    deliberately and only here: no counter → redirect still served, no flag → no cool-down.
  - **N4** (`eb8e761d`): `chat.companion_faltu_strike` v1 — `strike_count` (positive) +
    `cooldown_started`, `.strict()`, registered, tested. The registry count pin moved 212 → 213.
  - **N3/N5/N6** (`b3585650`): the faltu handler (strikes → redirect; threshold → cool-down +
    `cooldown_until`; event; Redis-refusal paths), the copy pairs `V2_FALTU_REDIRECT` /
    `V2_FALTU_COOLDOWN` with twins, `v2CooldownTurn`, the registry gating for `faltu` and
    `new_resume`, the `companion_task:new_resume` chip, and the ORDER across the two layers
    that own the branches (phase file "Order in code"): task-chip recognition → cool-down gate
    (service) → v1 resolver → lexicon → classifier (orchestrator).
  - **A1** (`7b5b464b`): +46 faltu (abuse beyond the shipped lexicon, flirting, jokes, cricket/
    film/small talk) and +30 new-résumé lines; set now 234 cases, no duplicates, mixed scripts.
- **Design calls made, recorded rather than discovered:**
  1. **Task-chip taps route deterministically, before the cool-down gate and before v1.** v1's
     weak signals answer "Resume badlo" and "Naya resume" with the digest (both contain
     "resume"), so without this step no tapped chip could ever reach its handler — in P1 either,
     where the chip was left to the classifier v1 intercepts. Exact label/key match only; typed
     sentences stay free text (`companion-task-chips.ts`).
  2. **The cool-down blocks free text, including text v1 would answer.** That is the spec's
     order ("chip keys → cool-down → v1 text resolver"); chip taps skip the gate, so the résumé
     and jobs stay reachable.
  3. **The lexicon runs BEFORE the gateway**, on the raw text: nothing crosses a boundary on
     that path (fixed copy + a strike count), so a flagged message costs no gateway hop and no
     model call, and is never stored (no memory pair). Abusive text appears in no event, log or
     Redis key.
  4. **The guard turn records `intent_source: "guard"`, `v2_intent: null`, `outcome: "cooldown"`**
     — no classifier ran, so naming an intent would be a claim the pipeline cannot make. The
     cool-down turn still carries the open chips.
  5. **Redis failure = fail open, and the strike event tells the truth:** a refused counter
     emits nothing (no fabricated zero); threshold crossed but the flag refused → redirect, and
     `cooldown_started: false`.
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 12,000+ passed / 153 skipped (719 in the chat-companion
    subtree; +40 on the phase).
  - ai-service `pytest` 6,048+ passed · `ruff` clean · `pnpm lint` 0 errors · typecheck 29/29.
- **Notes / surprises:** `handler.ts`'s "a handler NEVER writes anything" was corrected — the
  faltu handler owns its Redis counters and emits its strike event; the doc now says what it
  means (no DOMAIN writes).
- **Next:** the Frontend items F1/F2 (issue #1821 — raised with this phase); then Phase 3 when
  the owner calls it.

---

## Phase 3 — Career talk — 2026-09-29 18:10

- **Done:** A1–A3 + C1–C6, on `feat/companion-v2-phase3-career-talk`, one commit per task group.
  - **A1** (`87901240`): the four contracts (worker context, input, answer, refuse) in Pydantic +
    Zod + the golden fixture, the refusal-topic set in `@badabhai/types`, and parity/bounds/union
    tests on both sides. `status` is REQUIRED on both members — a missing discriminant must fail,
    not be defaulted into a shape the model did not mean.
  - **A2** (`8855d33a`): the route, prompt and model routing. **The fallback needed a new
    mechanism**: `TaskRoute` gained additive `model` / `fallback_model`, because O7 asks for
    Claude primary + Gemini fallback while the global `default_fallback_model` is ALSO Claude —
    and the router skips a same-provider candidate, so the career chain would otherwise have no
    fallback at all. `default_career_model` (settings/env) drives the primary; temperature 0.4,
    512-token budget, json_mode. The parser maps every unreadable output to
    `refuse/unsafe_other` (reviewed copy, never a fabricated answer). `companion_career_answer`
    was made nameable on the event spine in the SAME change that routes it.
  - **C1–C6** (`4d491709`): the validator (persona scan, Devanagari bar, money-word+digit,
    promises, sensitive advice, rating patterns, the platform's org-name and PII heuristics, the
    ≤1-question budget, chips under the same checks), the handler (context → model → spend →
    branch → event), the five reviewed refusal pairs with twins, the event
    `chat.companion_career_answered` v1 (registry 213 → 214), the flag, the chip, and
    `HandlerInput.recentTurns` so the career answer reads up to six memory turns without a
    second Redis hop.
  - **A3** (`30b4d78f`): 180 red-team prompts (28/26/26/25/25 across the five refusal topics +
    50 normal questions, Hinglish/Devanagari/English, jailbreak wrappers) with a scorer whose
    bars are §6's; the CLI gains `--career`. THE CLI IS STRICTER THAN §6 ON PURPOSE: it counts
    only a REFUSAL or no response as safe, so it gates on zero answers to risky prompts; the
    API validator (the half §6 also credits) is measured by its own deterministic tests.
- **Design calls recorded:**
  1. `read_aloud: false` is PRESENT and false on model turns only (O9). Refusal turns are fixed
     copy with reviewed twins and keep their read-aloud; a shipped client must not be able to
     fall back to speaking the model's `reply`.
  2. The validator reuses the platform's existing detectors (`checkPersonaTokens` — which
     already carries the banned-vocative rule R8 — `looksLikeOrgName`, `looksLikePii`) rather
     than growing private copies; the money rule is a money WORD next to a DIGIT, so advice
     about salary without a figure stays legal.
  3. A schema miss is a REFUSAL, not null: the API's fallback line is for a real answer that
     failed validation, while a contract miss means there was never an answer to judge — the
     reviewed refusal is the safer and more honest disposition.
  4. The handler emits its own outcome event (`chat.companion_career_answered`) before the
     orchestrator's turn event; both carry closed sets only.
- **Checks:**
  - `pnpm --filter @badabhai/api test` — 12,159 passed / 153 skipped (770 in the chat-companion
    subtree) · lint 0 errors · typecheck 29/29.
  - ai-service `pytest` 6,082 passed · `ruff` clean.
- **Notes / surprises:** the service-auth route pin and the ledger-coverage pin both caught the
  new surface exactly as designed (a POST route must be TD67-gated; a routed task must be
  nameable on the spine), so both were updated in the change that added the route.
- **Next:** the Frontend items F1/F2 (issue #1824); the staging `eval_cli --career` run is the
  release gate before any flag-ON, alongside owner review of 30 sampled answers (§6).

---

## Audit + completion — 2026-09-30 → 2026-10-01

- **Why:** the checklists said "complete", but nobody had seen v2 on a device (#1843), and the
  five v2 flags went ON in production on 2026-09-30 07:34 UTC (owner-authorized) before any of
  the release gates ran.
- **Audit:** six slice auditors checked this spec against the actual code on `origin/main`
  (`967d2719`): API P1, API P2+P3, contracts/privacy, ai-service, worker app, rollout. Every
  not-done item then went to an independent skeptic told to refute it, and a completeness critic
  hunted for requirements nobody had covered. 129 gaps survived (99 confirmed, 30 partly
  confirmed). None was refuted. The PROGRESS/checklist claims were NOT taken as evidence.
- **The headline defect:** a confirmed edit never produced a résumé. `ResumeService.generate` sent
  every system call to `createInitial(overwrite:false)`, `ON CONFLICT DO NOTHING` handed back the
  existing v1, and the render was skipped as "already rendered". Meanwhile the worker was told
  "update ho raha hai", a cap slot was spent and a paid call was thrown away. The tests mocked
  `ResumeService`, so nothing caught it.
- **Fixed (all merged to `main`, verified on `origin/main`):**
  - **#1869 ai-service:**
    - `field` on every edit-parse row;
    - one token scope for the message and snapshot (two employers no longer share a placeholder);
    - career prompt names the persona tokens;
    - career traces filed under `companion`;
    - `eval_cli` scores production routing, survives a failed call, and gates p95 latency;
    - `--dump-samples` for the 30-answer review;
    - runbook `docs/ops/companion-v2-staging-evals-runbook.md`.
  - **#1871 edit path:**
    - a `chat_edit` is a NEW history entry, queued, with the cap decided before spend, behind `resume_generation` consent;
    - preferences false/empty applied; several rows on one list; qualification targeting; at-most-once confirm (atomic claim);
    - only the touched lists re-saved; no-op adds dropped; the writers' real DTO schemas;
    - night-shift seed; stale check robust to reorder;
    - API-side row and snapshot caps; card kept on a rolled-back confirm;
    - deterministic identity check; `V2_EDIT_PLACEHOLDER`; `cancelled(expired)`;
    - `field_label` / `before_display` / `after_display` on card rows;
    - the stale 409 carries the reviewed turn.
  - **#1872 router + career validator:**
    - a chip is intercepted only while its phase flag is on (rule 6);
    - "Resume badlo" / "Career ki baat" taps serve `V2_EDIT_ASK` / `V2_CAREER_ASK` instead of a billed model call on their own label;
    - classifier-detected faltu is never stored in memory;
    - 1,000-char classify bound; career ≤ 6 turns;
    - the boot egress test covers `v2/handlers/**`;
    - `submission_id` replay (no second strike, call or memory pair);
    - `cooldown_until` on the open turn; Redis reads bounded on the open path;
    - validator: Latin-only (renamed from the "Devanagari bar" of C1), whole-word money within a sentence plus bare `15k`/`thousand`/`kamai`/`income`/`wage`/`stipend`, full emoji set.
  - **#1878 TD145:** a re-driven general-handover flush keeps `general_form_completed_at`.
  - **Worker app:**
    - **#1867 (Rishi), for #1862:** the companion mic never mints a session; a Hindi note prefers `transcript_english`; one mic; the cool-down survives a gone card; Nahi neutral; plain Hinglish; dead `readAloud` state removed.
    - **#1874:** demo mode.
- **Production facts measured (read-only, 2026-09-30):** 0130's CHECK lists `chat_edit`. Its
  ledger row is not adopted, and neither are 0128, 0129 or 0131. No `chat_edit` rows exist yet.
  No `chat.companion_turn_served_v2` row existed.
- **First eval gate run (2026-10-01, #1883):** FAIL on all three tasks (classify p95, edit-parse 78.4 %,
  career 1 unsafe, served rate 80.4 %) — the box append stays blocked.
- **Raised:** #1876 (worker-app F6, shipped #1880: render the row labels, the stale turn, and the card kept on a
  failed confirm) and #1875 (gateway does not mask an ALL-CAPS employer; pre-existing, every
  caller).
- **Remaining:** the owner checklist in the README Status section (signatures, staging evals,
  30-answer review, copy review, rulings, then the box append), and TD146–TD150.

---

## WP1 — security: control characters in the career answer gate (#1943) — 2026-10-05

- **Done:** `career-output.validator.ts` refuses `\p{Cc}` other than `\t \n \r` in every line and chip
  (new closed failure reason `control_char`), closing the C0/C1 hole a Common-script character left:
  `"Tata Steel L\u0001td"` and `"Tata Steel\u0085Ltd"` read as a legal suffix to the worker while
  `looksLikeOrgName`/`looksLikePii` saw none. The grep for the same gap found the edit card: an
  edit row whose VALUE carries a control is dropped by `validateRow`. Risks register **R57** added.
  PR **#1972**; issue **#1943** fixed.
- **Checks:** api 570 files / 13,851 passed · lint 0 errors · typecheck 30/30 · ai-contracts 140 ·
  event-schema 388 · ai-service ruff clean; the 19 pytest failures are pre-existing environment
  failures on `main` (resume extract/parse on this box).
- **Notes / decisions / surprises:** the new failure reason is log/test-only, so no event change.
- **Next:** none; re-measured only by the human's staging run.

## WP2 — copy: the legal_medical_financial refusal — 2026-10-05

- **Done:** the refusal now names all three domains — "Yeh kanoon, sehat ya paise ka mamla hai. Iske
  liye vakil, doctor ya bank se salah lijiye." — with a matching Devanagari twin; the refusal-copy
  loop now covers all five topics; a regression test pins the six domain words. `contracts.md` §8
  updated. PR **#1974**.
- **Checks:** api suite green; the line passes the persona suite automatically (ALL_COPY_PAIRS).
- **Notes / decisions / surprises:** the draft sent a health question to a lawyer or a bank.
- **Next:** owner copy review (checklist 4).

## WP3 — edit-path safety: qualification deletes Profile-only (TD151(1)) — 2026-10-05

- **Done:** qualifications are EDIT-only; `wholeEntryDelete()` generalises `isWholeJobDelete`; a
  qualification delete is dropped at propose as `whole_entry_delete` (counts-only
  `reason=qualification_delete_from_chat`), the prompt routes credential removals to `other`, the
  eval gold expects no row, and a stored ticked delete is refused at confirm. Frontend issue
  **#1977** raised for TD151(2) (unticked destructive rows). Register TD151(1) → done (provisional).
  PR **#1978**.
- **Checks:** api 570 / 13,856 · ai-service companion pytest 96 pass · ruff clean.
- **Notes / decisions / surprises:** the apply-plan's qualification-delete branch is kept as defence
  in depth and now pinned by a PURE plan test instead of through confirm.
- **Next:** owner sign-off; re-arm `companion_edit_parse` only after the paid eval passes.

## WP4 — edit-parse quality: list fields and prompt pass — 2026-10-05

- **Done:** `v2/edit-normalise.ts` (pure) expands an `edit` on a list member into `delete old` +
  `add new` before validation, fail closed on ambiguity; the edit prompt gains the measured miss
  categories (lists, job city vs preferred cities, karta/aata verb, year-only dates, chahiye/notice/
  institute, Latin values, proper-name casing); the gold set adds the credential "hata do" cases.
  PR **#1988**.
- **Checks:** api 572 / 14,022 · ai-service companion 96 pass · ruff clean.
- **Notes:** the real accuracy is the human's staging re-run; no paid calls made here.
- **Next:** human `--edit-parse` run with `--expect-model gemini-2.5-flash-lite`.

## WP5 — classify latency — 2026-10-05

- **Done:** classify prompt 1085 chars / 178 words → 791 / 116; `max_output_tokens` 64 → 48
  (worst-case answer ~15 tokens); json_mode/temperature 0 already in place; production routing to
  `default_cheap_model` (`gemini-2.5-flash-lite`) and the eval CLI's fallback-run failure confirmed.
  PR **#1986**.
- **Checks:** ai-service suite + ruff green; api suite green.
- **Notes:** before/after recorded in the PR body; the p95 on the primary is the human's measurement.
- **Next:** human `--classify` run.

## WP6 — route precedence (TD146) — 2026-10-05

- **Done:** new flag `CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED` (default false) wired through
  config/env/compose/ci/deploy preflight/guards. On: a chip tap stores a one-shot pending intent
  (Redis, 10 min, GETDEL); `edit-precheck.ts` routes edit verb + field phrasings to the edit
  handler; a v1 weak alias goes to the classifier; every named v1 intent keeps its zero-model
  answer. Off is v1 byte-for-byte. PR **#1994**.
- **Checks:** api 573 / 14,065 · config 200 · both deploy guard tests · boot test.
- **Notes:** the three TD146 phrasings change behaviour only with the flag on.
- **Next:** human turns the flag on in staging, then production (checklist).

## WP7 — career validator (TD147) — 2026-10-05

- **Done:** new `employers` module (employer-name repository + decrypting, normalising, 15-min TTL
  index) run by the career handler after the pure validator; `SENSITIVE` narrowed (case/policy/
  doctor removed, each with must-pass and must-refuse tests); µ/Ω allowed as units. Served-rate
  replay on the stored `career-all.json`: **51/51 = 100.0 %** (bar 85 %), PASS. PR **#1996**.
- **Checks:** api 602 / 14,180 · employers suite 24 · validator 214 · ruff clean.
- **Notes:** the index lives outside `chat-companion` because that leaf's egress boot test forbids
  the PII-crypto import; the module imports neither chat nor any chat-table writer.
- **Next:** owner sign-off; the paid red-team/served-rate re-run is human.

## WP8 — event v2s and in-flight idempotency (TD150) — 2026-10-05

- **Done:** `turn_served_v3` (`chip`), `edit_cancelled_v2` (`worker_declined`/`expired`/`stale`/
  `superseded`), `edit_confirmed_v2` (`skipped_no_consent`), `edit_rolled_back` v1, strike/career v2
  with `submission_id`; `CompanionTurnReplayStore.claim/release` (SET NX EX 60 s) makes a concurrent
  duplicate answer `V2_IN_FLIGHT` with no model call, strike, memory write or event. Contracts
  §4/§7/§8 updated. PR **#1997**.
- **Checks:** api 602 / 14,194 · event-schema 398 · ai-contracts 140 · lint/typecheck green.
- **Notes:** additive only; the old emitters moved to the new names so nothing double-counts.
- **Next:** none.

## WP9 — cost alert docs (TD149) — 2026-10-05

- **Done:** README provisional-rulings table created with the TD149 row ("O12 is satisfied by the
  admin dashboard; no push alert until an alerting channel exists") and `ai_cost_alert_profile_inr`
  fixed ₹20 → ₹5 (it sat above the ₹10 per-call ceiling and could never trip). PR **#1998**.
- **Checks:** test_ai_router 32 pass · ruff clean.
- **Notes:** `ai_target_profile_cost_inr` (₹15) deliberately out of scope and documented.
- **Next:** owner accepts the dashboard-only ruling in writing (or asks for a channel).

## WP10 — docs and status — 2026-10-05

- **Done:** README Status + checklist + provisional-rulings table completed; this PROGRESS entry
  per WP; tech-debt-register TD146/147/149/150/151 rows updated with statuses and PR numbers.
  PR **#<WP10-PR>**.
- **Checks:** docs-only; api/ai-service gates unchanged from WP9's run and re-run in the PR.
- **Notes:** the remaining items are human-only: ADR signatures, the paid staging evals, the
  30-answer review, the box's `AI_REAL_CALL_TASKS` append, arming the route-precedence flag, the
  0130 ledger adoption, and the manual test script.
- **Next:** the owner's steps, in the order in the final report.
