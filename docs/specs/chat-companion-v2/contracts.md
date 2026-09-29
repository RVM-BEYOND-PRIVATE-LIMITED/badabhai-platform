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

## 2. AI-service contracts

Zod in `packages/ai-contracts`, mirrored in Pydantic in `apps/ai-service/app/contracts.py`
(the existing mirror convention; a parity test must cover the new models).

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
    field: string | null,                         // required for edit; must be in catalogue
    value: string | null,                         // required for add/edit
  }[],                                            // 0..max_rows
  unsupported: ("identity" | "contact" | "other")[],   // things asked that cannot be edited here
}
```

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

## 3. Edit catalogue (P1)

`apps/api/src/chat-companion/v2/edit-catalogue.ts` — the ONLY place that maps a section to its
existing writer. Identity and contact are absent by construction (O3).

| `EditSection` | Ops | Writer (existing) | Notes | Verified (T0, 2026-09-28) |
|---|---|---|---|---|
| `employment` | add / edit / delete | `WorkerEmploymentService` (`PUT /workers/me/employment`) | fields: employer, role, city, start/end or years | Method + DTO confirmed. Repo opens its OWN transaction; no `tx` param. Additive `tx?: Database` required (§3.1). Emits `worker.employment_recorded` v1. |
| `skills` | add / delete | **RÉSUMÉ-ONLY writer (new, T7)** — owner ruling 2026-09-28 | worker-side/profile only: append/remove labels on the confirmed profile's résumé snapshot; NO `worker_skill` / `job_reach` writes, NO ADR-0030/job-domain canonicalization; matching untouched | **RULED (owner, 2026-09-28), resolving P1-OQ1.** The named `setWants` writer is an unwired seam that THROWS (`worker-skills.service.ts:187`). T7 builds a deterministic résumé-only skills writer that edits the profile snapshot the renderer prints (`raw_profile.resume_profile.skills` when the container carries values, else `raw_profile.skills` / `raw_profile.skill_labels`). The canonical column `worker_profiles.skills` and everything downstream of matching are deliberately NOT touched. |
| `languages` | add / delete | `WorkerLanguagesService` | closed language list | Method + DTO confirmed. Repo opens its OWN transaction; no `tx` param. Additive `tx?: Database` required (whole-list replace, §3.1). Emits `worker.languages_recorded` v1. |
| `qualifications` | add / edit / delete | `WorkerQualificationsService` | closed options endpoint | Method + DTO confirmed. Repo opens its OWN transaction; no `tx` param. Additive `tx?: Database` required (whole-list replace, 3 lists, §3.1). Emits `worker.qualifications_recorded` v1. |
| `occupations` | add / delete | `WorkerOccupationsService` | canonical ids only | Method + DTO confirmed. Repo opens its OWN transaction; no `tx` param. Additive `tx?: Database` required (whole-list replace, §3.1). Emits `worker.occupations_recorded` v1; also calls `WorkerSkillsService.rebuildQuietly` after the write. |
| `preferences` | edit | `WorkerPreferencesService` | closed options (shift, city, pay range) | Method + DTO confirmed. `WorkerAttributesRepository.upsertMany` / `deleteKeys` ALREADY accept `tx?: Database`; the service passes none. Emits `worker.preferences_recorded` v1. |

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
          before: string | null, after: string | null }[],
},
read_aloud?: false,                    // P3: present and false on model-written replies (O9);
                                       // the app must NOT fall back to speaking `reply`
cooldown_until?: string,               // P2: ISO; app may disable the composer until then
```

Old apps ignore unknown keys (`ChatReply.fromJson` reads named keys only). `.strict()` stays: the
fields are declared, so the schema still rejects undeclared ones.

### 5.2 New routes (P1)

| Route | Body | Responses |
|---|---|---|
| `POST /chat/companion/edits/:proposalId/confirm` | `{ row_ids: uuid[] (1..3), submission_id?: uuid }` | 200 turn · 404 unknown/expired/other worker's · 409 `{mode:"interview"}` · 409 `{reason:"stale"}` |
| `POST /chat/companion/edits/:proposalId/cancel` | `{ submission_id?: uuid }` | 200 turn · 404 |

Auth: worker bearer token (same guard as v1). The worker id always comes from the token, never
the body. `proposalId` is looked up under that worker's key only (no cross-worker oracle: 404).

### 5.3 Chip keys (fixed, in `companion-keys.ts`, mirrored in the app's `chat_companion_keys.dart`
and covered by the existing parity test)

| Key | Label | Phase |
|---|---|---|
| `companion_task:edit_resume` | Resume badlo | P1 |
| `companion_task:new_resume` | Naya resume | P2 |
| `companion_task:career_talk` | Career ki baat | P3 |
| `companion_task:jobs` | Naye jobs *(v1's existing jobs chip)* | v1 |

Task chips are shown only for intents whose phase flag is on.

## 6. Flags and knobs

Server (`packages/config`, `docs/environment-variables.md`, `ci.yml` deploy env list):

| Name | Default | Meaning |
|---|---|---|
| `CHAT_COMPANION_V2_ENABLED` | `false` | Master switch for the v2 pipeline |
| `CHAT_COMPANION_V2_EDIT_ENABLED` | `false` | P1 edit handler |
| `CHAT_COMPANION_V2_NEW_RESUME_ENABLED` | `false` | P2 |
| `CHAT_COMPANION_V2_FALTU_ENABLED` | `false` | P2 |
| `CHAT_COMPANION_V2_CAREER_ENABLED` | `false` | P3 |
| `CHAT_COMPANION_V2_ROUTER_MIN_CONFIDENCE` | `0.6` | Below → `unclear` |
| `CHAT_COMPANION_V2_EDIT_MAX_ROWS` | `3` | O5 |
| `CHAT_COMPANION_V2_PROPOSAL_TTL_SECONDS` | `600` | Edit card lifetime |
| `CHAT_COMPANION_V2_FALTU_STRIKES` | `3` | O11 |
| `CHAT_COMPANION_V2_FALTU_COOLDOWN_MINUTES` | `30` | O11 |
| `CHAT_COMPANION_V2_MEMORY_TURNS` | `6` | O13 |
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
| `proposal:{workerId}` | JSON (one active proposal per worker; a new one replaces it) | `PROPOSAL_TTL_SECONDS` | edit service | no card is offered: "abhi badlav nahi ho paaya, thodi der mein try karein" |
| `strikes:{workerId}:{utcDay}` | counter | 24 h | faltu handler | no strike counted |
| `cooldown:{workerId}` | flag | `FALTU_COOLDOWN_MINUTES` | faltu handler | no cool-down |

Memory stores the **pseudonymized** text the AI service returned, never the raw text.

## 8. Copy

All fixed lines live in `companion-replies.ts` (v1 file, extended) with a Devanagari twin, and pass
`companion-replies.test.ts` (persona tokens, ≤20 words, ≤1 "?", no "!", no emoji). Keys:

| Key | Latin (draft — needs owner review) |
|---|---|
| `V2_PHASE_OFF` | Yeh feature abhi aana baaki hai. Aap kisi aur baare mein baat kar sakte hain. |
| `V2_JOBS_DEFERRED` | Chat se jobs dhoondhna abhi aana baaki hai. Aap kisi aur baare mein baat kar sakte hain. |
| `V2_CLARIFY` | Samajh nahi aaya. Aap inme se kya karna chahte hain? |
| `V2_EDIT_CARD_INTRO` | Yeh badlav karne hain? Dekh kar Haan dabaiye. |
| `V2_EDIT_NONE` | Kya badalna hai, samajh nahi aaya. Thoda aur batayiye. |
| `V2_EDIT_IDENTITY` | Naam aur phone Profile mein jaa kar badliye. |
| `V2_EDIT_DONE` | Badlav ho gaya. Aapka resume update ho raha hai. |
| `V2_EDIT_DONE_CAPPED` | Badlav ho gaya. Resume aaj update nahi ho sakta, kal ho jayega. |
| `V2_EDIT_CANCELLED` | Theek hai, kuch nahi badla. |
| `V2_EDIT_STALE` | Profile beech mein badal gaya. Dobara bataiye kya badalna hai. |
| `V2_FALTU_REDIRECT` | Main resume aur kaam mein madad karta hoon. Inme se kuch chuniye. |
| `V2_FALTU_COOLDOWN` | Thodi der baad baat karte hain. |
| `V2_CAREER_REFUSE_*` | one line per refusal topic (P3) |
| `V2_FALLBACK` | v1 `FALLBACK` reused |

"Aana baaki hai" copy is the owner's wording (O2); the rest are drafts for review before flag-ON.
