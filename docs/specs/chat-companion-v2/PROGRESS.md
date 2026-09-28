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
