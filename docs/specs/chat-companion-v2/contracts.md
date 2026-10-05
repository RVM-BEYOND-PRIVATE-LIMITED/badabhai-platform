# Chat Companion v2 — shared contracts

Every contract here is **additive**. Names are final unless a phase file's "Open questions" says
otherwise. Where a contract is used first is noted as (P1) / (P2) / (P3).

## 1. Intents

`packages/types/src/index.ts`, beside the ADR-0044 companion vocabularies:

```ts
export const COMPANION_V2_INTENTS = [
  "edit_resume",   // P1
  "career_talk",   // P3
  "jobs_talk",     // deferred — always the fixed "abhi aana baaki hai" line (O2)
  "new_resume",    // P2
  "faltu",         // P2
  "unclear",       // P1 — low confidence, invalid output, model failure
] as const;
export type CompanionV2Intent = (typeof COMPANION_V2_INTENTS)[number];

export const COMPANION_V2_INTENT_SOURCES = ["v1_deterministic", "lexicon", "llm", "guard", "fallback"] as const;
export const COMPANION_V2_OUTCOMES = [
  "served", "proposed", "phase_off", "clarify", "cooldown", "refused", "fallback",
] as const;
```

An intent whose phase flag is off is still **classified** (so the metrics show demand) but answered
with the `phase_off` line + task chips.

**What each intent source means** (the enum is closed and shipped; this is its meaning, not a new
value). `v1_deterministic` is a deterministic, zero-model route taken before the classifier — in
practice **only a task-chip tap** (§5.3). A v1 resolver **hit** is not a v2 turn: it is served by v1
and records v1's own `chat.companion_turn_served`, even while v2 is on. `lexicon` = the P2 abuse
lexicon; `llm` = the classifier; `guard` = the P2 cool-down; `fallback` = gateway blocked/unreachable
or classifier null/blocked.

## 2. AI-service contracts

Zod in `packages/ai-contracts`, mirrored in Pydantic in `apps/ai-service/app/contracts.py`
(the existing mirror convention; a parity test must cover the new models).

"Pseudonymized by the endpoint" below holds while `AI_RAW_PII_ENABLED` is off. Armed
([ADR-0047](../../decisions/0047-lift-pii-restriction.md)), each endpoint passes the text through
`llm_input_policy` unmasked (size caps kept) and the orchestrator skips its `/pseudonymize` hop;
`blocked` then means only an oversize or non-string input. The wire shapes do not change.

### 2.1 `POST /companion/classify` (P1) — task `companion_classify`, Gemini Flash, json_mode

```ts
CompanionClassifyInput = {
  text: string,                       // ≤ 1000 chars; pseudonymized by the endpoint
  recent_turns: { role: "worker" | "bada_bhai", text: string }[],   // ≤ 2, from Redis memory
}
CompanionClassifyOutput = {
  intent: CompanionV2Intent,
  confidence: number,                 // 0..1
  blocked: boolean,                   // pseudonymizer blocked the input (fail closed → unclear)
}
```

The API treats `confidence < CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE`, `blocked`, a schema miss,
a timeout or a null (AI service down) as `unclear`.

**The API sends at most the first 1000 chars** of the pseudonymized message (`CLASSIFY_TEXT_MAX`,
never splitting a surrogate pair). The message DTO accepts 4000, and an over-long `text` would be a
422 → `unclear` for a message that was perfectly clear. The handler still receives the WHOLE masked
text (edit-parse and career accept 4000); memory stores the clipped text (§7).

### 2.2 `POST /companion/edit-parse` (P1) — task `companion_edit_parse`, Gemini Flash, json_mode

```ts
CompanionEditParseInput = {
  text: string,                                   // pseudonymized by the endpoint
  catalogue: EditableField[],                     // closed list the API sends (§3)
  snapshot: { ref: string, section: EditSection, fields: Record<string, string | null> }[],
  // ref = opaque short ref the API minted for this request ("e1", "q2"); never a DB id
  max_rows: number,                               // CHAT_COMPANION_V2_EDIT_MAX_ROWS (3)
}
CompanionEditParseOutput = {
  rows: {
    op: "add" | "edit" | "delete",
    section: EditSection,
    ref: string | null,                           // required for edit/delete; null for add
    field: string | null,                         // required on EVERY row (add/edit/delete); in catalogue
    value: string | null,                         // required for add/edit
  }[],                                            // 0..max_rows
  unsupported: ("identity" | "contact" | "other")[],   // things asked that cannot be edited here
}
```

**`EditableField`** (owner ruling 2026-09-29, A1) is
`{ section: EditSection, field: string, ops: ("add" | "edit" | "delete")[] }`.
`field` is the LOGICAL name the model should use (e.g. `expected_salary`); the API maps it to its
writer's DTO key itself. `ops` is the legal subset for that field, and the only place the code and
the model both learn that **`add` exists only where ONE field defines the entry** — skills,
languages, occupations. Qualifications and employment are **edit-only** (an "add" request gets the
profile-screen line), because a new employment or credential is inherently multi-field and the card
carries one `value` per row (O5 caps a message at 3 rows). Neither offers `delete` either —
**"Never from chat"**: chat never deletes a worker's whole job (owner ruling, 2026-10-01) nor a
whole certificate, education or training (TD151(1) provisional default, 2026-10-05; a carded
whole-entry delete was the same one-Haan shape); that happens only on the Profile screen (§3.2).
The catalogue is API-authored constants; it never carries worker text.

**`field` on every row (audit fix, 2026-09-30).** The API resolves each row through its
`(section, field)` catalogue entry before any op-specific check, so a row with `field: null` is
dropped whatever its op. The prompt therefore requires a catalogue `field` on add, edit **and**
delete, and the ai-service parser drops a field-less row itself (a row the API would drop anyway,
so the observable contract is unchanged; the wire type stays `string | null` for Zod parity). For a
delete, `field` is the row's anchor: its only field (skill, language, role, one list-preference
member). A delete in qualifications no longer exists (TD151(1), 2026-10-05): a request to remove a
certificate, education or training gets no row and `other` in `unsupported`, like a job request
since 2026-10-01 ("Never from chat", §3.2). The `certificate_*` / `education_*` / `training_*`
anchors stay named in the prompt only for a card stored before that date.

**One token scope per edit-parse request (audit fix, 2026-09-30).** The endpoint pseudonymizes the
message and every snapshot value with ONE request-scoped numbering (`pseudonymize(..., scope=)`),
so the same entity carries the same placeholder in the message and in `current_values`, and two
different employers never share `[EMPLOYER_1]`. The token grammar is unchanged (`[PREFIX_n]`, still
caught by the API's O17 `hasPlaceholderToken` screen), no mapping is returned, and every other
gateway caller keeps its per-call numbering. No wire field changes.

**API-side bounds (2026-09-30, lane a2).** The model's output is untrusted, so the API enforces
both caps itself rather than relying on the AI service:

- `max_rows` sent = `min(CHAT_COMPANION_V2_EDIT_MAX_ROWS, 3, 10)` — never more than one confirm may
  tick (`EDIT_CARD_ROWS_MAX`, §5.2) nor than this contract accepts — and the API cuts the card to
  the same number whatever comes back. Rows past it count in `dropped_count`.
- `snapshot` is cut to the contract's 64 rows before sending (a 65-row body is a 422, which reads
  as "no rows" and would serve the clarify line forever). The cut is deterministic: rows are grouped
  by ref family (`e`, `s`, `l`, `c`, `q`, `t`, `o`, `pref`, `pc`, `wt`, `dr`) and the cap is
  water-filled smallest family first, so only the largest families (in practice skills) lose rows;
  within a family, rows whose current value appears verbatim in the message go first. A cut is
  logged with counts and `reason=snapshot_cap`, never a value. A ref the model was not shown
  cannot be addressed.
- `companion-edit.contract.test.ts` pins the API's restated `64` / `10` against this schema.

### 2.3 `POST /companion/career` (P3) — task `companion_career_answer`, Claude, json_mode

```ts
CompanionCareerInput = {
  text: string,                                   // pseudonymized by the endpoint
  recent_turns: { role: "worker" | "bada_bhai", text: string }[],   // ≤ 6 (O13)
  worker_context: { trade_label: string | null, experience_bucket: "0-1" | "1-3" | "3-7" | "7+" | null },
}
CompanionCareerOutput =
  | { status: "answer", lines: string[] /* 1..4, Latin Hinglish */, followup_chips: string[] /* 0..3 */ }
  | { status: "refuse", topic: "salary_promise" | "legal_medical_financial" | "named_employer" | "worker_rating" | "unsafe_other" }
```

The career handler sends the **newest 6** memory turns whatever `CHAT_COMPANION_V2_MEMORY_TURNS`
says (the knob has no ceiling; above 6 every call would be a 422 and every career event invalid), and
`turns_in_memory` on `chat.companion_career_answered` is the count actually sent.

**What is served is not always what the model wrote (owner, 2026-10-03).** The API's career
validator (phase-3 §2) drops a follow-up chip whose **only** failure is its length (> 4 words) and
serves the rest, so `suggested_followups` can hold fewer chips than `followup_chips` did — zero
included. Every chip still runs every content check first, and any content failure still serves
`V2_FALLBACK`; a long line or > 3 chips still does too. The output contract above, the turn shape
and the event (`outcome` `answered`) are unchanged.

## 3. Edit catalogue (P1)

`apps/api/src/chat-companion/v2/edit-catalogue.ts` — the ONLY place that maps a section to its
existing writer. Identity and contact are absent by construction (O3).

| `EditSection` | Ops | Writer (existing) | Notes | Verified (T0, 2026-09-28) |
|---|---|---|---|---|
| `employment` | edit *(chat; `add` deferred by the 2026-09-29 single-field-adds ruling; `delete` removed by the 2026-10-01 "Never from chat" ruling — a whole job is deleted only on the Profile screen, §3.2)* | `WorkerEmploymentService` (`PUT /workers/me/employment`) | fields: employer, role, city, start/end or years | Method + DTO confirmed. Repo opens its OWN transaction; no `tx` param. Additive `tx?: Database` required (§3.1). Emits `worker.employment_recorded` v1. |
| `skills` | add / delete | **RÉSUMÉ-ONLY writer (new, T7)** — owner ruling 2026-09-28 | worker-side/profile only: append/remove labels on the confirmed profile's résumé snapshot; NO `worker_skill` / `job_reach` writes, NO ADR-0030/job-domain canonicalization; matching untouched | **RULED (owner, 2026-09-28), resolving P1-OQ1.** The named `setWants` writer is an unwired seam that THROWS (`worker-skills.service.ts:187`). T7 builds a deterministic résumé-only skills writer that edits the profile snapshot the renderer prints (`raw_profile.resume_profile.skills` when the container carries values, else `raw_profile.skills` / `raw_profile.skill_labels`). The canonical column `worker_profiles.skills` and everything downstream of matching are deliberately NOT touched. |
| `languages` | add / delete | `WorkerLanguagesService` | closed language list | Method + DTO confirmed. Repo opens its OWN transaction; no `tx` param. Additive `tx?: Database` required (whole-list replace, §3.1). Emits `worker.languages_recorded` v1. |
| `qualifications` | edit *(chat; `add` deferred by the 2026-09-29 single-field-adds ruling; `delete` removed by the TD151(1) provisional default, 2026-10-05 — a whole credential is deleted only on the Profile screen, §3.2)* | `WorkerQualificationsService` | closed options endpoint | Method + DTO confirmed. Repo opens its OWN transaction; no `tx` param. Additive `tx?: Database` required (whole-list replace, 3 lists, §3.1). Emits `worker.qualifications_recorded` v1. |
| `occupations` | add / delete | `WorkerOccupationsService` | canonical ids only | Method + DTO confirmed. Repo opens its OWN transaction; no `tx` param. Additive `tx?: Database` required (whole-list replace, §3.1). Emits `worker.occupations_recorded` v1; also calls `WorkerSkillsService.rebuildQuietly` after the write. |
| `preferences` | edit | `WorkerPreferencesService` | RULED 2026-09-29: `shift`, `preferred_cities`, `job_type`, `work_types`, `documents_ready`, `willing_to_travel`, `willing_to_relocate`, `accommodation_needed`, `availability`, `expected_salary`. `expected_salary` is the LOGICAL field and is written to `salary_expected_max` with `salary_expected_min` cleared (the only end that prints today). REMOVED from the catalogue: `salary_period`, `commute_max_km`, the four `education_*` keys. | Method + DTO confirmed. `WorkerAttributesRepository.upsertMany` / `deleteKeys` ALREADY accept `tx?: Database`; the service passes none. Emits `worker.preferences_recorded` v1. |

### 3.1 T0 writer verification detail (2026-09-28)

| Section | Service + method (file) | Input DTO / Zod schema | Repo write + tx handle | Events |
|---|---|---|---|---|
| `employment` | `WorkerEmploymentService.replaceForWorker` (`apps/api/src/profiles/worker-employment.service.ts:64`) | `SetMyEmploymentSchema` (`worker-employment.dto.ts:148`; `.strict()`, ≤4 employments, whole-history replace, `expected_existing_count` stale guard) | `WorkerEmploymentRepository.replaceForWorker` (`worker-employment.repository.ts:128`) opens its own `this.db.transaction`; no `tx` param | `worker.employment_recorded` v1 (counts only) |
| `skills` | contract names `WorkerSkillsService.setWants` (`apps/api/src/match/worker-skills.service.ts:187`) — **throws**: "unwired seam". Working path: `ExtractedCorrectionsService.correctExtracted` (`profiles/extracted-corrections.service.ts:45`) | no wants DTO; corrections take `SkillsCorrectionSchema` (`extracted-corrections.dto.ts:38`; canonical `skill_*` ids, replace-whole-list) | no add/delete writer. `ProfileSkillsRepository.replaceForProfile` (`profile-skills.repository.ts:36`) opens its own transaction; no `tx` param. Also needs a pinned chat session + profile id (`CorrectExtractedSchema`) | `resume.edited` v1 (from the corrections path). RULING 2026-09-28: T7 builds a résumé-only writer instead — see §3 |
| `languages` | `WorkerLanguagesService.replaceForWorker` (`worker-languages.service.ts:44`) | `SetMyLanguagesSchema` (`worker-languages.dto.ts:59`; `.strict()`, one required whole list, ≤16, ≥1 ability per row) | `WorkerLanguagesRepository.replaceForWorker` (`worker-languages.repository.ts:42`) opens its own transaction; no `tx` param | `worker.languages_recorded` v1 (counts only) |
| `qualifications` | `WorkerQualificationsService.replaceForWorker` (`worker-qualifications.service.ts:65`) | `SetMyQualificationsSchema` (`worker-qualifications.dto.ts:259`; `.strict()`, three optional lists, ≥1 key) + `CertificateEntrySchema` / `EducationEntrySchema` | `WorkerQualificationsRepository.replaceForWorker` (`worker-qualifications.repository.ts:66`) opens its own transaction; no `tx` param | `worker.qualifications_recorded` v1 (counts only) |
| `occupations` | `WorkerOccupationsService.replaceForWorker` (`worker-occupations.service.ts:46`) | `SetMyOccupationsSchema` (`worker-occupations.dto.ts:34`; `.strict()`, one required whole list, ≤4, closed `role_*` ids) | `WorkerOccupationsRepository.replaceForWorker` (`worker-occupations.repository.ts:32`) opens its own transaction; no `tx` param; then `WorkerSkillsService.rebuildQuietly` | `worker.occupations_recorded` v1 (+ `worker.match_skills_rebuilt` v1 from the rebuild) |
| `preferences` | `WorkerPreferencesService.setForWorker` (`worker-preferences.service.ts:67`) | `SetMyPreferencesSchema` (`worker-preferences.dto.ts:113`; `.strict()`, partial patch, three-state per key, closed slugs) | `WorkerAttributesRepository.upsertMany` (`worker-attributes.repository.ts:46`) and `deleteKeys` (`:113`) **already accept** `tx?: Database`; the service passes none | `worker.preferences_recorded` v1 (counts only) |

Notes T7 must carry forward:

1. **Module reachability.** `ProfilesModule` exports only the five REPOSITORIES
   (`profiles.module.ts:183`), not the five services. `WorkerSkillsService` is @Global through
   `MatchModule`. `ChatCompanionModule` either imports `ProfilesModule` after it exports the
   services (additive) or provisions its own instances of them; the repositories are injectable today.
2. **Replace semantics.** employment / languages / qualifications / occupations replace the WHOLE
   list; preferences patches individual keys. One edit row must therefore read → mutate → replace
   for the four replace writers.
3. **Side effects run outside the transaction today.** Every writer emits its event and enqueues a
   re-render (or rebuild) AFTER its own repo transaction. For the confirm flow's "one transaction
   or not at all", the repos need `tx?: Database` and the events/renders must move to an
   after-commit step (T7 design).
4. **Events can join a transaction.** `EventsService.emit` already accepts `tx?: Database`
   (`events.service.ts:36`), so `chat.companion_edit_confirmed` can commit atomically with the writes.
5. **Skills: owner ruling 2026-09-28 (resolves P1-OQ1).** Build the missing writer, but
   **résumé/profile only**: T7 edits the confirmed profile's résumé snapshot (`raw_profile`)
   deterministically — no ADR-0030 canonicalization, no `worker_skill` / `job_reach` /
   `worker_profiles.skills` writes, so matching is untouched. The snapshot is read/mutated
   through the fields the renderer actually prints (see the §3 row). A later re-extraction or
   confirm may restore an edited-away skill; accepted under the ruling.

### 3.2 How a card row is validated and applied (2026-09-30, lane a2)

One pure module (`v2/edit-plan.ts`) turns a section's rows plus its current state into that
writer's input, parsed by the writer's REAL schema (`SetMy*Schema`). It runs twice:

- **At propose**, per row, after the per-row gates (catalogue, op, ref, the field belongs to the
  ref's entry, value, token, hard identifier (ADR-0047 G1), edit no-op) and the row-set gates — a
  second delete of one entry (the field is only a delete's anchor), an
  edit of an entry the same card deletes, a second edit of one field, a second add of one value
  (case-insensitive), and an ADD OF SOMETHING ALREADY STORED (case-insensitive; skills included)
  are all dropped. Each surviving row is tried together with the rows already accepted for its
  section; a row the writer's schema refuses (a phone number in an issuer, an end month before the
  start, a fifth occupation, a seventeenth language) never reaches a card.
- **At confirm**, against the state the stale check just read, and the parsed DTO goes to the
  writer on the transaction.

Per section:

| Section | Apply rule |
|---|---|
| `preferences` | Only the touched keys, with **`touched_only: true`** — without it the writer reads a `false` or a `[]` as an old build's default wherever a value is stored (#1504) and keeps the old answer. List rows FOLD: two rows on one list both land. |
| `qualifications` | A row's target is `{list, index, fp}` — `fp` a hash of the entry's carded fields (never the licence). Rows resolve to entry OBJECTS before anything moves (the entry at `index` if it still matches `fp`, else the first unclaimed match), so deletes never shift an edit onto another entry. **Only the lists named by the rows are sent**: an absent list survives, so rows the GET withheld (`partial`) in the other lists are never erased. |
| `skills` | An add already printed (case-insensitive, ids by label) is not appended — a label is never printed twice, even on a second Haan. |
| others | Unchanged: employment by `employment_id` (with `expected_existing_count`), languages by slug, occupations by role id. |

**The field must belong to the entry the ref names (2026-09-30, EDIT-ROW-KIND).** A section match
is not enough: `q1` is an education and `certificate_name` is a qualifications field, so
`delete q1 certificate_name` used to be carded — the apply removes the education (it goes by the
ref's list) under a row labelled "Yeh poora certificate" with `before: null`. Now a qualification
field's prefix (`certificate_` / `education_` / `training_`) must name the ref's own list, and
every other section's field must be one of the addressed row's own keys (a scalar preference only
on `pref`, a list member only on its own `pcN` / `wtN` / `drN`). Enforced three times: the
per-row gate at propose (the row is dropped, counted in `dropped_count`); the stale check (a
stored row whose field its entry lacks is `stale`, never read as a matching `before: null`); and
`edit-plan.ts`, which refuses a qualification row whose field names another list.

**"Never from chat" — no whole-entry delete.** The production primary model
(`gemini-2.5-flash-lite`) read "welder hata do" (drop the TRADE `role_welder`) as
`delete employment e1` in 3 of 3 measured repeats (`docs/qa/evidence/companion-v2/2026-10-01/`),
which the API carded as "Kaam · Yeh poora kaam" with the row pre-ticked, so one Haan would remove
the worker's whole job. The owner ruled on 2026-10-01 that chat never deletes a worker's whole job;
TD151(1)'s provisional default (2026-10-05) extends the same rule to a whole certificate, education
or training, which had the identical shape ("Yeh poora certificate", one Haan). Chat may still
EDIT every employment and qualification field. Enforced twice in the API, whatever the model
returns:

- **At propose.** No employment or qualification field offers `delete` (§3), and a
  `(section ∈ {employment, qualifications}, op = delete)` row is dropped as its own closed reason
  (`whole_entry_delete`) BEFORE the catalogue gate, whatever field it anchors on. It counts in
  `dropped_count` when a card survives; when nothing survives the worker gets
  `V2_EDIT_PLACEHOLDER` (§8). Each propose that drops one logs ONE line with counts, the worker id
  and a closed reason — `job_delete_from_chat`, `qualification_delete_from_chat`, or both — never a
  value.
- **At confirm** (a card stored before a ruling lives up to its 600 s TTL). A TICKED stored
  employment or qualification delete is never applied: right after the claim the card is retired
  exactly as a stale one — deleted, `cancelled(stale)`, 409 `{reason:"stale", turn}` — with nothing
  written, and the same closed-reason log line. An unticked one is inert.

The stale check matches a qualification row by `list` + `fp`, never by index, so a reordered list
still finds the entry and an entry edited elsewhere does not; a stored row without `fp` (none exist
in production: the model paths are dark) is stale. A section the confirm cannot re-read is NOT
stale — nothing is known about it — so the confirm writes nothing and serves the card again.

**A card row carries the value its writer will store (2026-10-03, #1940).** The employment and
qualifications writers store `employer_name` and the education `field` in the worker app's casing
(`titleCaseWords`, via `profiles/title-case-on-write.ts`). It raises the first letter of each word
and never lowercases anything. `normaliseValue` applies the same function, so for these two fields:

- **`after` is the cased value.** "mahindra logistics" is carded as "Mahindra Logistics", and Haan
  stores exactly that.
- **The edit no-op drop compares stored forms.** "tata motors" over a stored "Tata Motors" is no
  edit: it is dropped and counted in `dropped_count`. An uncased value stored before #1940 is
  carded as the casing Haan will apply ("tata motors" → "Tata Motors").
- **The stale check is unchanged.** `before` is the stored value, so a card stays valid across its
  own Haan. It is stale only if the row's bytes moved under it, for example because the #1432
  backfill re-cased the row.
- **An employment confirm re-sends the whole history,** so it also cases an older uncased employer
  name riding along in it, just as the form path does. The counts are not affected:
  `applied_count` is still the ticked rows, and `worker.employment_recorded` still counts
  employments.

`role_label` is NOT cased, by the writer or by the card. Casing it is an open owner decision.

After commit, a `preferences.shift` row runs the form path's own
`WorkerPreferencesService.seedNightShiftReadyFromShift` (now public; the writer skips it on a
joined transaction), before occupations' rebuild and the résumé regeneration.

**No regeneration queued → one re-render (2026-09-30, EDIT-RERENDER).** The employment,
languages, qualifications and preferences writers skip their own forced re-render on the joined
transaction, because a regeneration is to follow. When `resume_regen` is `capped` or `failed`
none follows, so the confirm runs the form path's re-render itself —
`ResumeRerenderService.enqueueLatest` (exported by `ResumeModule`), ONCE per confirm, LLM-free,
no consent or cap (it reprints the latest stored résumé with the live tables, in place: no new
version, no `resume.generated`). Only when the card touched a section the render reads LIVE —
employment, languages, qualifications, occupations (the "Also works as" row) or preferences;
a skills-only card gets none, because the render prints the skills stored with the résumé. Not
after a rollback, and not when `queued` (the new entry renders the live tables itself). The event
is unchanged.

## 4. Events (`packages/event-schema`, registry + payloads)

All `.strict()`, ids/counts/enums only, never text. v1 `chat.companion_turn_served` v1 is **not**
modified; v2 turns emit **v2** of it.

| Event | Version | Payload | Phase |
|---|---|---|---|
| `chat.companion_turn_served` | **v2** | v1 fields + `intent_source`, `v2_intent` (nullable), `confidence_bucket` (`lt50`/`50_70`/`70_90`/`gte90`/null), `outcome` | P1 |
| `chat.companion_edit_proposed` | v1 | `proposal_id`, `row_count`, `sections[]`, `dropped_count`, `unsupported[]` | P1 |
| `chat.companion_edit_confirmed` | v1 | `proposal_id`, `applied_count`, `sections[]`, `resume_regen` (`queued`/`capped`/`failed`) | P1 |
| `chat.companion_edit_cancelled` | v1 | `proposal_id`, `reason` (`worker`/`expired`/`stale`) | P1 |
| `chat.companion_faltu_strike` | v1 | `strike_count`, `cooldown_started` | P2 |
| `chat.companion_career_answered` | v1 | `outcome` (`answered`/`refused`/`fallback`), `refusal_topic` (nullable), `turns_in_memory` | P3 |

Dedupe: message turns by `submission_id` (as v1); edit events by `proposal_id`.

**`chat.companion_edit_cancelled{reason:"expired"}` (2026-09-30, lane a2).** Emitted when a Haan
or a Nahi names the worker's OWN stored card (the id under the bearer's key, never merely the
URL's) after its `expires_at`; the route still answers 404. The proposal record is kept
`PROPOSAL_EXPIRY_GRACE_SECONDS` (300 s) past `expires_at` so a late tap is recognisable, and is
left to lapse rather than deleted (a delete could race a newer card). Not emitted, and not
representable without a new reason (an Architect decision): a card replaced by a newer proposal,
and a card nobody taps again — so `proposed − confirmed − cancelled` still has a remainder.

**`resume_regen` (2026-09-30, lane a1).** Decided on the Haan request by
`ResumeService.queueChatEditRegeneration`, before anything is spent: `queued` = the worker's
daily-cap slot is charged and a `resume-generate` job (`trigger: "chat_edit"`) exists; `capped` =
the cap (or its fail-closed Redis check) refused; `failed` = nothing will be generated — no
`resume_generation` consent (checked first, so no slot and no model call), no readable draft, or
the job could not be queued (its slot handed back). The closed set has no separate value for the
consent case; recording it apart needs a v2 of the event (Architect), so it is `failed` today.

**The generation itself (ADR-0046 O6).** The job writes a NEW `generated_resumes` row labelled
`chat_edit` on the edited profile (never the profile's initial row), emits `resume.regenerated`
and queues its render; a queue retry converges onto the `chat_edit` row it already wrote. The
processor re-checks consent, and a CHECK violation (0130 not applied) is terminal.
**Retries replay (2026-09-30).** The app re-sends the same `submission_id` on a retry. A v1 miss that
carries one is answered, on a retry, with the v2 turn already served for it (Redis
`turn:{workerId}:{submissionId}`, §7) — no second classify/edit-parse/career call, no second faltu
strike, no second memory pair, no second outcome event. Fail-open: an unreadable cache processes the
message as before. A retry that arrives while the first request is STILL running is not covered.
A **fail-closed** turn (`intent_source: fallback` — gateway or classifier unreachable, blocked or
off-contract) is never kept: a retry usually follows a slow AI path, so it is processed afresh rather
than answered with the pinned clarify line. Its v2 event is still deduped on the submission id (the
spine keeps the first attempt's `fallback` row), and a classifier failure's masked memory pair may be
stored twice.

**`chat.companion_turn_served_v2` field meanings.** `intent` is always v1's `fallback` ("no named v1
intent answered"; nominal for chip and guard turns, which run before v1). `v2_intent` is the intent
the turn was routed on — the chip's, the lexicon's `faltu`, or the classifier's (recorded even below
the confidence floor) — and null on the guard and fail-closed paths. `confidence_bucket` is set only
when the classifier answered.

Registry key note (T3, 2026-09-28): the v2 turn is minted as **`chat.companion_turn_served_v2`**
(`version: 2`), the house new-name pattern (`feed.shown_v2`, `profile.viewed_v2`,
`resume.edited_v2`) — `validateEvent` allows one version per name, so v1 keeps its definition and
its emitter unchanged.

## 5. Wire (API ⇄ app)

### 5.1 `CompanionTurnSchema` — additive optional fields (`chat-companion.dto.ts`)

```ts
edit_proposal?: {
  proposal_id: string,                 // uuid
  expires_at: string,                  // ISO
  rows: { row_id: string, section_label: string, op: "add" | "edit" | "delete",
          before: string | null, after: string | null,
          field_label?: string,              // 2026-09-30 (lane a3), additive — see below
          before_display?: string | null,    //   "
          after_display?: string | null }[], //   "
},
read_aloud?: false,                    // P3: present and false on model-written replies (O9);
                                       // the app must NOT fall back to speaking `reply`
cooldown_until?: string,               // P2: ISO; app may disable the composer until then
```

`cooldown_until` rides the refused message's turn AND, while `CHAT_COMPANION_V2_ENABLED` and
`CHAT_COMPANION_V2_FALTU_ENABLED` are on and a cool-down is running, the **open** turn of
`GET /chat/companion` — so a composer lock survives an app restart. Same field, same shape; absent
otherwise (the open is then byte-for-byte what it was).

Old apps ignore unknown keys (`ChatReply.fromJson` reads named keys only). `.strict()` stays: the
fields are declared, so the schema still rejects undeclared ones.

**Row labels (2026-09-30, lane a3 — BUG-CARD-LABELS, POLISH-language-slugs).** `section_label`
names only the section, so two rows of one section could not be told apart ("Pasand: Nahi → Haan"
— travel, relocation or a room?), and single-word slugs (`hindi`, `pan`, `cbse`, `immediate`)
reached the card as typed tokens. Each row now also carries, ADDITIVELY:

- `field_label` — the field the row changes, as reviewed copy (`EDIT_FIELD_LABELS` in
  `companion-replies.ts`, §8). Present on every row the server builds. A **delete in
  qualifications** removes the whole entry (the field is only the model's anchor), so its label
  names the entry instead (`EDIT_ENTRY_LABELS`: "Yeh poora certificate", "Yeh poori padhai",
  "Yeh poori training"). `EDIT_ENTRY_LABELS.employment` ("Yeh poora kaam") is unreachable from a
  new proposal since 2026-10-01 ("Never from chat", §3.2); it labels only a card stored before
  that ruling, which the confirm never applies. The qualification kind is read from the row's
  resolved target (`target.list` — the entry the apply removes), never from the anchor field; a
  qualification delete whose target names no list gets NO `field_label` rather than a guess.
- `before_display` / `after_display` — the worker-facing label of a CLOSED-SET value, read from
  the dictionaries that already label it elsewhere: `LANGUAGES`, `EDUCATION_QUALIFICATIONS`,
  `EDUCATION_COUNCILS`, `SHIFTS`, `JOB_TYPES` / `WORK_TYPES`, `AVAILABILITY_STATUSES`,
  `DOCUMENTS_READY` (`profiles/worker-preferences.vocabulary.ts` — the labels the options
  endpoints serve as form chips and the résumé prints), `labelForTaxonomyId` for a role id (as
  `GET /workers/me/occupations` labels it), and `EDIT_YES_NO_LABELS` ("Haan" / "Nahi") for the
  three yes/no preferences. Always present (possibly null). **Null** when the value is null, when
  the field is free text, a date or a number (a name, a city, `2019-01`, a salary — shown as
  stored, never re-cased for display; an employer name or education field `after` is already the
  cased value its writer stores, §3.2), or when a closed-set field holds a value its dictionary
  does not know (a legacy model-written availability, a retired slug) — never a guessed
  prettification.

`before` / `after` are unchanged (the stored tokens). The labels are derived at WIRE time from
the stored row's section, field and values — never stored in Redis — so a card saved before this
change is served labelled on a retry. The app should show `field_label` beside `section_label`
and prefer `*_display` over its own humaniser when non-null (Frontend issue needed;
`companion_edit_value.dart` then shrinks to a fallback for old servers).

### 5.2 New routes (P1)

| Route | Body | Responses |
|---|---|---|
| `POST /chat/companion/edits/:proposalId/confirm` | `{ row_ids: uuid[] (1..3), submission_id?: uuid }` | 200 turn · 404 unknown/expired/other worker's/already confirmed · 409 `{mode:"interview"}` · 409 `{reason:"stale", turn}` |
| `POST /chat/companion/edits/:proposalId/cancel` | `{ submission_id?: uuid }` | 200 turn · 404 |

Auth: worker bearer token (same guard as v1). The worker id always comes from the token, never
the body. `proposalId` is looked up under that worker's key only (no cross-worker oracle: 404).

Confirm behaviour (2026-09-30, lane a2 — all additive on the wire):

- **At most once.** The confirm CLAIMS the card (`SET NX`, §7) before applying anything. A double
  tap, a retry while the first request is still working, or a re-confirm after a lost delete finds
  it claimed and gets the already-confirmed **404**. A Nahi claims too, so a Nahi racing a Haan is
  404 for whichever came second.
- **Nothing written → 200 with the card.** A writer failure (rolled back whole), a section the
  confirm could not re-read, or a claim Redis refused answers 200 with the `V2_FALLBACK` turn
  CARRYING THE SAME `edit_proposal` (same `proposal_id`, same `row_id`s), so the app's normal
  turn path keeps the card and Haan can be tapped again until `expires_at`. A rolled-back apply
  hands its claim back.
- **Stale → 409 `{reason:"stale", turn}`.** `reason` is unchanged; `turn` is the reviewed
  `V2_EDIT_STALE` turn (`reply` + `tts_text`), for the app to show in place of a line of its own.
  A card stored before 2026-10-01 with a ticked whole-job delete takes this path too, nothing
  written ("Never from chat", §3.2).
  Like every error it sits under `error` in the `AllExceptionsFilter` envelope.
- A card carries at most `EDIT_CARD_ROWS_MAX` (3) rows — the confirm DTO's own bound — and the
  outbound schema says so.

### 5.3 Chip keys (fixed, in `companion-keys.ts`, mirrored in the app's `chat_companion_keys.dart`
and covered by the existing parity test)

| Key | Label | Phase |
|---|---|---|
| `companion_task:edit_resume` | Resume badlo | P1 |
| `companion_task:new_resume` | Naya resume | P2 |
| `companion_task:career_talk` | Career ki baat | P3 |
| `companion_task:jobs` | Naye jobs *(v1's existing jobs chip)* | v1 |

Task chips are shown only for intents whose phase flag is on — and a posted label/key is
**recognised as a tap only while that same flag is on** (one table, `companion-task-chips.ts`, so
shown ⇔ routed). With the flag off the text is typed text and goes to v1 first, exactly as before the
chip existed ("naya resume" → v1's redo menu, never the phase-off line).

A recognised tap never sends its label to a model (it names a task, not a request):

| Tap | Answer | Event |
|---|---|---|
| Resume badlo | `V2_EDIT_ASK` + task chips | `intent_source: v1_deterministic`, `v2_intent: edit_resume`, `outcome: served` |
| Career ki baat | `V2_CAREER_ASK` + task chips | same, `v2_intent: career_talk` |
| Naya resume | the new-résumé handler (redo menu; consent-gated) with the SERVER label | same, `v2_intent: new_resume` |

No memory pair is stored for a tap, and the NEXT message goes through the normal order (v1 first);
routing it straight to the chip's handler would be a v1 bypass, which is an owner decision.

**Decision taken provisionally — TD146 / WP6 (2026-10-05), behind
`CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED` (default off).** With the flag on, a tap on
`companion_task:edit_resume` / `:career_talk` stores a **pending intent** for that worker (Redis,
10-minute TTL, one-shot) and the next free-text message routes straight to that handler — no v1
resolver, no classifier. A second tap replaces it; another chip clears it; a take consumes it.
Also with the flag on, a narrow reviewed table (`v2/edit-precheck.ts`: an edit verb + a field
word) routes edit phrasings to the edit handler BEFORE v1, and a v1 **weak alias** (the résumé
menu's substring aliases, the résumé/greeting words, the bare `kaam`) goes to the classifier
instead of answering with the menu/recap; every NAMED v1 intent (exact chips, the menu's chips,
jobs, applications, guarantee, status) keeps its zero-model answer. With the flag off the flow is
byte-for-byte today's, pinned by `companion-v2.v1-first.test.ts`.

## 6. Flags and knobs

Server (`packages/config`, `docs/environment-variables.md`, `ci.yml` deploy env list):

| Name | Default | Meaning |
|---|---|---|
| `CHAT_COMPANION_V2_ENABLED` | `false` | Master switch for the v2 pipeline |
| `CHAT_COMPANION_V2_EDIT_ENABLED` | `false` | P1 edit handler |
| `CHAT_COMPANION_V2_NEW_RESUME_ENABLED` | `false` | P2 |
| `CHAT_COMPANION_V2_FALTU_ENABLED` | `false` | P2 |
| `CHAT_COMPANION_V2_CAREER_ENABLED` | `false` | P3 |
| `CHAT_COMPANION_V2_ROUTE_PRECEDENCE_ENABLED` | `false` | TD146/WP6 — a chip tap leaves a pending intent (10 min, one-shot) and the edit pre-check runs before v1; off is v1 byte-for-byte |
| `CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE` | `0.6` | Below → `unclear` |
| `CHAT_COMPANION_V2_EDIT_MAX_ROWS` | `3` | O5 |
| `CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS` | `600` | Edit card lifetime |
| `CHAT_COMPANION_V2_FALTU_STRIKES` | `3` | O11 |
| `CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES` | `30` | O11 |
| `CHAT_COMPANION_V2_MEMORY_TURNS` | `6` | O13 — stored turns; the classifier reads 2 and career sends at most 6 whatever this says |
| `CHAT_COMPANION_V2_MEMORY_TTL_SECONDS` | `1800` | O13 |

App (Remote Config, default `false`): `worker_chat_companion_v2_enabled` (sends v2-capable UI:
task chips, edit card, voice button). Server flags decide behaviour; the app flag only decides
whether the app can render v2 fields.

## 7. Redis keys

Reuse the BullMQ connection (pattern: `apps/api/src/resume/resume-rate-limit.service.ts`). No second
client. All keys are prefixed `companion:v2:`.

| Key | Type | TTL | Written by | If Redis fails |
|---|---|---|---|---|
| `mem:{workerId}` | list, pseudonymized turns, capped at `MEMORY_TURNS` | `MEMORY_TTL_SECONDS` | orchestrator | classify/answer without memory |
| `proposal:{workerId}` | JSON (one active proposal per worker; a new one replaces it) | `PROPOSAL_TTL_SECONDS` + 300 s grace (the card itself still ends at `expires_at`; the grace only lets a late tap be recorded `expired`, §4) | edit service | no card is offered: "abhi badlav nahi ho paaya, thodi der mein try karein" |
| `proposal-claim:{workerId}:{proposalId}` | flag, `SET NX` — one Haan/Nahi per card | same as the proposal record | edit service (confirm / cancel; released on a rollback) | confirm applies nothing and serves the card again; cancel proceeds (it writes nothing) |
| `pending-intent:{workerId}` | string, `edit_resume` / `career_talk` | 600 s (fixed, not a knob) | task-chip tap (`set`, replaces); next free-text message (`GETDEL`, one-shot); any other chip (`DEL`) | no pending intent: the message takes the normal v1-first path |
| `strikes:{workerId}:{utcDay}` | counter | 24 h | faltu handler | no strike counted |
| `cooldown:{workerId}` | flag | `FALTU_COOLDOWN_MINUTES` | faltu handler | no cool-down |
| `turn:{workerId}:{submissionId}` | JSON, the v2 turn served for a v1-miss message | 600 s | orchestrator | fail open: the retry is processed as a new message |

**"If Redis fails" includes "Redis never answers" (2026-09-30).** The shared BullMQ connection runs
with `maxRetriesPerRequest: null` and the default offline queue, so a command against a downed Redis
is buffered and never rejects; a try/catch alone would hang the request. The `mem`, `turn` and
`cooldown` reads/writes on a request path therefore run under `withinRedisDeadline`
(`apps/api/src/queue/redis-deadline.ts`, 150 ms, shared with the pack cache) and take the right-hand
column on a timeout — so the tab's open (`GET /chat/companion`, which reads `cooldown`) and a v1-miss
message cannot hang on Redis. NOT yet bounded: the `strikes` INCR and the `cooldown` SET (an
abandoned write still lands later, as a strike or cool-down the strike event never reported) and
`proposal:*` — a Redis outage still stalls a faltu turn and the edit path.

Memory stores the **pseudonymized** text the AI service returned, never the raw text — while
`AI_RAW_PII_ENABLED` is off. Armed (ADR-0047), it stores the worker's own words: still Redis only,
still trimmed to `MEMORY_TURNS`, still expiring on `MEMORY_TTL_SECONDS`. Either way each worker
turn is clipped to 1000 chars (the store drops longer turns on read), and **never** stored for a
message the lexicon OR the classifier called `faltu` (any confidence, faltu phase on or off):
pseudonymizing masks PII, not abuse. The replay key holds only what the worker was already sent
(fixed copy, a validated career answer, or an edit card whose values `proposal:{workerId}` already
holds); never the message, raw or masked, whichever way the flag is set.

## 8. Copy

All fixed lines live in `companion-replies.ts` (v1 file, extended) with a Devanagari twin, and pass
`companion-replies.test.ts` (persona tokens, ≤20 words, ≤1 "?", no "!", no emoji). Keys:

| Key | Latin (draft — needs owner review) |
|---|---|
| `V2_PHASE_OFF` | Yeh feature abhi aana baaki hai. Aap kisi aur baare mein baat kar sakte hain. |
| `V2_JOBS_DEFERRED` | Chat se jobs dhoondhna abhi aana baaki hai. Aap kisi aur baare mein baat kar sakte hain. |
| `V2_CLARIFY` | Samajh nahi aaya. Aap inme se kya karna chahte hain? |
| `V2_EDIT_CARD_INTRO` | Yeh badlav karne hain? Dekh kar Haan dabaiye. |
| `V2_EDIT_NONE` | Kya badalna hai, samajh nahi aaya. Thoda aur batayiye. — Served when no row survives and neither line below applies. |
| `V2_EDIT_IDENTITY` | Naam aur phone Profile mein jaa kar badliye. — Served when no row survives and the model's `unsupported` names identity/contact OR the message itself names the worker's own name / phone / ID number (`v2/edit-identity.ts`, deterministic, 2026-09-30). |
| `V2_EDIT_PLACEHOLDER` | Yeh badlav chat se nahi ho sakta. Profile mein jaa kar badliye. — **DRAFT (2026-09-30), pending owner review.** Served when no row survives, the identity line does not apply, and (a) at least one row was dropped for a placeholder token (O17: a masked company or person name chat can never write back), or (b) at least one was dropped as a whole-entry delete ("Never from chat": a job, 2026-10-01; a certificate/education/training, TD151(1) 2026-10-05, §3.2), or (c) the model's `unsupported` names `other` — "things asked that cannot be edited here" (§2.2), so "not from chat, use Profile" is the true answer and rephrasing cannot help (2026-10-01; it used to get `V2_EDIT_NONE`). |
| `V2_EDIT_DONE` | Badlav ho gaya. Aapka resume update ho raha hai. |
| `V2_EDIT_DONE_CAPPED` | Badlav ho gaya. Resume abhi update nahi hua, baad mein Resume tab se update karein. — **DRAFT (2026-09-30), pending owner review.** Served for `capped` and `failed` (incl. no `resume_generation` consent). Replaces "Resume aaj update nahi ho sakta, kal ho jayega": nothing regenerates later on its own, so the line promises no time. **Owner question (2026-09-30, EDIT-RERENDER):** when this line is served the confirm now also re-renders the PDF with the live tables (§3.2), so an edit to work history, languages, qualifications, occupations or preferences DOES reach the PDF once that render runs; the line under-states that (only skills wait for a regeneration). Copy unchanged pending that review. |
| `V2_EDIT_CANCELLED` | Theek hai, kuch nahi badla. |
| `V2_EDIT_STALE` | Profile beech mein badal gaya. Dobara bataiye kya badalna hai. |
| `V2_FALTU_REDIRECT` | Main resume aur kaam mein madad karta hoon. Inme se kuch chuniye. |
| `V2_FALTU_COOLDOWN` | Thodi der baad baat karte hain. |
| `V2_CAREER_REFUSE_*` | one line per refusal topic (P3). `legal_medical_financial`, fixed 2026-10-05 (the owner checklist named it: it sent a health question to "a lawyer or a bank"): **Yeh kanoon, sehat ya paise ka mamla hai. Iske liye vakil, doctor ya bank se salah lijiye.** Devanagari twin matches. Still a draft pending owner review, like the others. |
| `V2_FALLBACK` | v1 `FALLBACK` reused |
| `V2_EDIT_ASK` | **DRAFT (2026-09-30), pending owner review.** Resume mein kya badalna hai? Jaise: 'Marathi bhasha jod do' ya 'night shift kar do'. |
| `V2_CAREER_ASK` | **DRAFT (2026-09-30), pending owner review.** Career ke baare mein aapka kya sawaal hai? Jaise: 'nayi skill kaun si seekhun'. |

"Aana baaki hai" copy is the owner's wording (O2); the rest are drafts for review before flag-ON.

**Edit-card row labels (§5.1) — DRAFT (2026-09-30, lane a3), pending owner review.** Worded after
the form label the worker filled the value in on where one exists (`finishing_screen.dart`,
`trade_form_*_page.dart`, the profile tab), as plain labels (no "?"); never "company" (the
persona scan's counterparty rule), hence "Kahan kaam kiya" for the employer. Each carries a
Devanagari twin in `companion-replies.ts` and is in `ALL_COPY_PAIRS`, so the persona and twin
tests scan it.

| Key | Latin |
|---|---|
| `EDIT_FIELD_LABELS["employment:employer_name"]` | Kahan kaam kiya |
| `EDIT_FIELD_LABELS["employment:employer_city"]` | Kaam ka sheher |
| `EDIT_FIELD_LABELS["employment:employer_state"]` | Kaam ka state |
| `EDIT_FIELD_LABELS["employment:start_ym"]` | Kab shuru kiya |
| `EDIT_FIELD_LABELS["employment:end_ym"]` | Kab tak kiya |
| `EDIT_FIELD_LABELS["employment:role_label"]` | Aapka role |
| `EDIT_FIELD_LABELS["employment:work_done"]` | Kya kaam karte the |
| `EDIT_FIELD_LABELS["skills:skill"]` | Skill |
| `EDIT_FIELD_LABELS["languages:language"]` | Bhasha |
| `EDIT_FIELD_LABELS["qualifications:certificate_name"]` | Certificate ka naam |
| `EDIT_FIELD_LABELS["qualifications:certificate_issuer"]` | Certificate kisne diya |
| `EDIT_FIELD_LABELS["qualifications:certificate_year"]` | Certificate ka saal |
| `EDIT_FIELD_LABELS["qualifications:education_credential"]` | Padhai |
| `EDIT_FIELD_LABELS["qualifications:education_field"]` | Trade ya subject |
| `EDIT_FIELD_LABELS["qualifications:education_council"]` | Council / board |
| `EDIT_FIELD_LABELS["qualifications:education_year"]` | Padhai ka saal |
| `EDIT_FIELD_LABELS["qualifications:education_institute"]` | Institute ka naam |
| `EDIT_FIELD_LABELS["qualifications:training_name"]` | Training ka naam |
| `EDIT_FIELD_LABELS["qualifications:training_provider"]` | Training kisne di |
| `EDIT_FIELD_LABELS["qualifications:training_year"]` | Training ka saal |
| `EDIT_FIELD_LABELS["occupations:role_id"]` | Role |
| `EDIT_FIELD_LABELS["preferences:shift"]` | Shift |
| `EDIT_FIELD_LABELS["preferences:job_type"]` | Naukri ka type |
| `EDIT_FIELD_LABELS["preferences:willing_to_travel"]` | Travel kar sakte hain |
| `EDIT_FIELD_LABELS["preferences:willing_to_relocate"]` | Doosre sheher ja sakte hain |
| `EDIT_FIELD_LABELS["preferences:accommodation_needed"]` | Rehne ki jagah chahiye |
| `EDIT_FIELD_LABELS["preferences:expected_salary"]` | Salary ki ummeed *(no period: a stored `salary_period` may be `day`)* |
| `EDIT_FIELD_LABELS["preferences:availability_status"]` | Kab join kar sakte hain |
| `EDIT_FIELD_LABELS["preferences:availability_available_from"]` | Join karne ki tareekh |
| `EDIT_FIELD_LABELS["preferences:availability_notice_period_days"]` | Notice period ke din |
| `EDIT_FIELD_LABELS["preferences:preferred_cities"]` | Kahan kaam karna chahte hain |
| `EDIT_FIELD_LABELS["preferences:work_types"]` | Kaun si naukri chalegi |
| `EDIT_FIELD_LABELS["preferences:documents_ready"]` | Taiyaar document |
| `EDIT_ENTRY_LABELS.employment` | Yeh poora kaam *(a whole-entry delete — unreachable from a new proposal since the 2026-10-01 "Never from chat" ruling; kept only for a card stored before it)* |
| `EDIT_ENTRY_LABELS.certificate` | Yeh poora certificate |
| `EDIT_ENTRY_LABELS.education` | Yeh poori padhai |
| `EDIT_ENTRY_LABELS.training` | Yeh poori training |
| `EDIT_YES_NO_LABELS.true` / `.false` | Haan / Nahi *(the app's own yes/no words)* |

The closed-set VALUE labels (`before_display` / `after_display`) are not new copy: they are the
existing English dictionary labels the form chips and the résumé already show.
`V2_EDIT_ASK` / `V2_CAREER_ASK` answer a task-chip tap (§5.3). Their quoted examples are v1 misses
(asserted by test), so a worker who types one reaches the router, not a v1 menu. Each `V2_EDIT_ASK`
example is also a change the edit catalogue can make (a `languages.language` add, a
`preferences.shift` edit — asserted by test); the first draft's "shehar Pune kar do" was not (the
catalogue has no home-city field). No salary figure is used as an example: the copy suite forbids
any 4-digit number on a line.

**These two drafts go live on the deploy that ships them, not on a flag:** `CHAT_COMPANION_V2_EDIT_ENABLED`
and `CHAT_COMPANION_V2_CAREER_ENABLED` are already on in production, so their review gates the MERGE.
Until the owner signs them off (recorded here in place of the DRAFT marker), the alternative is the
previous tap behaviour — the label sent to the edit-parse / career model — which the audit found
wrong on its own terms (a billed model call on a label that names no change; a model answer to a
non-question).
