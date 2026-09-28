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
