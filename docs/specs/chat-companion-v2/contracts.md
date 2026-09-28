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

| `EditSection` | Ops | Writer (existing) | Notes |
|---|---|---|---|
| `employment` | add / edit / delete | `WorkerEmploymentService` (`PUT /workers/me/employment`) | fields: employer, role, city, start/end or years |
| `skills` | add / delete | `WorkerSkillsService.setWants` after ADR-0030 canonicalization | phrase → `skill_id` with floor 0.75; below floor → row dropped |
| `languages` | add / delete | `WorkerLanguagesService` | closed language list |
| `qualifications` | add / edit / delete | `WorkerQualificationsService` | closed options endpoint |
| `occupations` | add / delete | `WorkerOccupationsService` | canonical ids only |
| `preferences` | edit | `WorkerPreferencesService` | closed options (shift, city, pay range) |

**Phase 1 task 0** verifies each writer: its input DTO, whether it accepts a transaction handle, and
whether it emits its own event. A writer that cannot join a transaction gets an additive optional
`tx` parameter; if that is not possible, the section is left out of the v2 catalogue and noted
in the phase file.

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
