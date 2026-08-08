# Voice Profiling Form — Implementation Plan

Hinglish voice-driven sequential Q&A for the worker app: questions shown one at a time, read aloud,
answered by speaking or by tapping a chip, in one sitting. Sarvam STT in, Sarvam TTS out.

**Status date:** 2026-08-08 · **HEAD:** `22d27364`

---

## Owner rulings (2026-08-07)

| Question | Ruling |
|---|---|
| Where `attribute` answers land (was the V2 blocker) | **A `worker_attributes` table.** Normalized, RLS-locked, one live row per (worker, key) — the matcher can filter on it with a plain index. Shipped in V1. |
| Voice-clip retention | **Never deleted.** `retention_policy` stays `retain_indefinitely`. Erase-on-request (DSAR) is unchanged — that is a legal obligation, not a retention policy — but the DPDP notice copy in V9 must now state indefinite retention explicitly, and TD58's purge job is re-scoped from "delete on a schedule" to "delete on request, provably". |
| One pipeline for both surfaces | **Both surfaces must build the profile the same way.** See §1a. |

---

## Status

### Shipped

| What | Where | State |
|---|---|---|
| Silent-turn blank-reply fix + `servedText` re-serve | PR #641 → `2d4354ac` | **on `main`** |
| Desktop bridge QR pointed at `/i/` (closes #607) | PR #642 → `7502a09c` | **on `main`** |
| 16 worker-app issues, assigned RishiBamako | #624–#639 | **filed, open** |
| **V0** — Sarvam `TtsAdapter` + `tts_smoke --matrix`, armed by nothing | PR #645 → `4d0989f8` | **on `main`** |
| **V1** — migration 0071 data spine (`worker_attributes`, `profiling_voice_answer`, pack pin, retention index) | PR #647 → `6f33a5aa` | **on `main`, applied** |
| **V2** — attribute projection + the yes/no lexicon + select-option capture | PR #651 → `a639b7bc` | **on `main`** |
| **V3** — the OIE Phase 8 cutover: the interview is deterministic, the LLM parses once | PR #650 → `2aa71d79` | **on `main`** |
| Live-run fixes — `catalog_version` 500, event-validation diagnostics, compound chip labels | PR #656 → `952305ea` | **on `main`** |
| Pack pin made durable + `profile.pack_pinned` | PR #661 → `27a28b18` | **on `main`** |
| **V4 (the three defects)** — a worker's answer could vanish behind a green tick | PR #664 → `40e61575` | **on `main`** |
| **V7** — the interview's one LLM call was unledgered; `aiTaskType` widened 3 → 8 | PR #665 → `46a1fa17` | **on `main`** |
| **V5 (the enumeration half)** — the 433-clip reply closure + the `{{…}}` corpus guard | PR #667 | **on `main`** |
| **The 77%'s writer** — a table and a projector that nothing joined | PR #670 → `5394c292` | **on `main`** |
| A mock call reporting real rupees | PR #672 → `ca5cd4e3` | **on `main`** |
| **B-8b** — one definition of "the current profile"; 7 readers, one unordered, one un-deduped | PR #678 → `d5365b57` | **on `main`** |
| **B-8a** — a call that never left the process claimed `success: true` and emitted a cost row | PR #681 → `ff676fe8` | **on `main`** |
| **V4b** — `VoiceTranscriptionService` extracted; `VoiceModule` exports; the DSAR **orphan** sweep | PR #682 | **on `main`** |

### Already built and reusable (this is most of the system)

| Capability | Path | Change needed |
|---|---|---|
| Deterministic question engine, **zero LLM calls** | `apps/api/src/profiling/next-question.ts`, `answer-capture.ts`, `answer-map.ts`, `predicate.ts` | none |
| Turn orchestrator, Redis CAS, reply cache | `apps/api/src/profiling/orchestrator.service.ts` | extended (V3) |
| 101 Hinglish question packs, 466 items | `packages/db/data/question-packs/packs/*.json` | content only |
| Pack tables + seeder + corpus validator | `packages/db/src/schema/question-pack.ts`, `seed-question-packs.ts`, migration 0069 | none |
| Fail-closed projector (map beats LLM) | `apps/api/src/profiling/answer-map-projector.ts` | **V2 — see the gap** |
| Six never-invent gates, TS + Python mirror | `parse-gates.ts`, `parse_gates.py` | none |
| Sarvam STT, real + chunked, fail-closed, spend-tracked | `apps/ai-service/app/stt.py`, `audio_chunk.py` | none — armed by env |
| STT smoke CLI (drives the production adapter) | `apps/ai-service/app/cli/stt_smoke.py` | none — it *is* the harness |
| Voice upload/transcribe pipeline + minted-key IDOR guard | `apps/api/src/voice/**` | extended (V4) |
| Flutter recorder, 120s cap, permission, temp-clip hygiene | `apps/worker-app/lib/features/voice/**` | new sibling class (V6) |
| DSAR voice erase leg | `apps/api/src/auth/account-deletion.service.ts:204-259` | extended (V1) |

### Blocked / unknown — these gate the work

| # | Item | State |
|---|---|---|
| **B-1** | Packs **seeded** in each environment | `db:seed:packs` appears in **no workflow, no runbook, no e2e**. CI runs only `--corpus` (DB-free). Unverified per environment. |
| **B-2** | Sarvam TTS accepts **romanized** Hinglish at `hi-IN` | Unknown. 0 of 466 pack items contain a Devanagari codepoint. Resolved by V0. |
| **B-3** | Round-trip latency for a ≤30s answer | Unmeasured. Every number in the repo is a timeout, never an observation. Resolved by V0. |
| ~~**B-4**~~ | Where `attribute` answers land | **RESOLVED** — owner ruled `worker_attributes`; the table shipped in V1 (migration 0071). The *wiring* is V2. |
| ~~**B-5**~~ | `envelope.occupation` is never written | **RESOLVED** by V3 (#650). Measured live: "main welder hoon" → `jd_nco_7212_0301` via `l0_exact` at 0.97 → the WELDING pack served → 13-turn interview → 10 typed rows in `worker_pack_answer`. |
| ~~**B-6**~~ | The two surfaces do not share a parse/build pipeline | **RESOLVED, and this row was STALE rather than open.** Re-derived against code 2026-08-08: `/profile/parse` has a live caller (`ProfileExtractionProcessor.extractOrParse:483`), `projectProfile` has a live caller beside it (`:552`), and `worker_profiles` has exactly ONE writer — `ProfilesRepository.create` — which both legs converge on. It closed with the V3 cutover (#650) and was completed by #670. The dual leg that remains is the upstream AI CALL only (`/profile/parse` vs `/profile/extract`) and it branches on DATA — a pre-cutover session has no answer map — so it drains to zero within one queue's lifetime. Lesson: a doc row saying "zero callers" is a measurement with an expiry date. |
| ~~**B-7**~~ | The pack pin was never written to `chat_sessions` | **RESOLVED** by #661. Found by running the product, not by reading it: the live database showed `pack pinned: (none)` for a session that had just been served thirteen welding questions. The columns shipped in V1 with a comment justifying them and no writer; a Redis eviction therefore re-ran retrieval and could hand a resumed interview a different pack. Now written write-once at pin time, read back only when the envelope is gone, and recorded by `profile.pack_pinned`. |
| ~~**B-8a**~~ | An unreachable ai-service fabricates an **empty draft profile** | **RESOLVED — in two halves, months apart.** The CONSEQUENCE was closed earlier: `decideProfileStatus` runs `hasExtractedContent` over the row it is about to write, so the fabrication persists as `"draft"` and both dedupe guards re-run extraction — the worker self-heals. **The signal is now closed too, by #681:** `ProfileExtractionOutputSchema` gained `error_code` (additive, defaulted, mirrored in Pydantic and in the golden key fixture), the unreachable fallback authors `extract_service_unreachable`, and it no longer synthesizes `ai_metadata` — so no `ai_jobs` usage row and no `ai.cost_recorded` event describe a provider call that did not happen. `is_mock` was never a discriminator: the ai-service returns `is_mock = not real_call`, so every healthy extraction under the committed `AI_ENABLE_REAL_CALLS=false` default carries it too. |
| ~~**B-8b**~~ | `create` is insert-only, so a later empty extraction shadows a good one | **RESOLVED by #678, and it was worse than logged.** Seven readers each answered "which row is the profile" differently: five ordered by `created_at DESC` alone, `ReachRepository.findSignalRowByWorkerId` had **no `ORDER BY` at all**, and `ReachRepository.listSignalRows` had neither ordering nor per-worker dedup — so a re-interviewed worker occupied **two** payer-pool slots and was counted twice in PACE supply. Now one exported `CURRENT_PROFILE_ORDER`, keyed off `profile_status` — which already IS the persisted `hasExtractedContent` decision, so no SQL mirror of it was needed and no second definition exists to drift. |

### 1a. ONE PIPELINE — CLOSED (re-derived against code, 2026-08-08)

Owner ruling: the voice form must parse and build the profile *exactly* the way the chat does. Two
ways of doing the same thing is two things to keep correct.

**They share one now, and the table below is kept as the RECORD OF WHAT WAS TRUE, not of what is.**
Every cell in the OIE column has since gained a caller: `AiService.parseProfile` is invoked from
`ProfileExtractionProcessor.extractOrParse`, its result runs the six gates a second time, and
`projectProfile` feeds the SAME `ProfilesRepository.create` the chat leg reaches. There is exactly one
`.insert(workerProfiles)` in application code.

The original gap, for the record:

| | Chat (live) | OIE / voice (as designed) |
|---|---|---|
| ai-service call | `POST /profile/extract` | `POST /profile/parse` — **zero callers in `apps/api`** |
| Never-invent gates | **do not run** | six gates, TS + Python mirror |
| Write path | `ProfileExtractionProcessor` → `ProfilesRepository.create` | `projectProfile` — **zero callers** |
| Table write | `INSERT … ON CONFLICT (ai_job_id) DO NOTHING` | none yet |

**The convergence, and it is the voice side that moves.** `worker_profiles` keeps exactly one
writer — `ProfilesRepository.create`, reached through `ProfilesService`. V3's finalize leg produces
a `WorkerProfileDraft` (deterministic `projectProfile`, plus the gated `/profile/parse` overlay when
it is available) and hands it to **that** service. It does not open a second write path, and it does
not touch the chat's own trigger.

Two live defects this exposed. **Both are now resolved — see B-8a/B-8b above** — and they are kept here
because the second turned out to be a whole class rather than one query:

1. `AiService.extractProfile` **fabricates** an empty draft when the ai-service is unreachable —
   `DraftProfileSchema.parse({})` with `blocked: false`. A degraded call is indistinguishable from a
   worker who said nothing.
2. `create` is insert-only per `ai_job_id`, and readers resolve "the" profile by
   `created_at DESC LIMIT 1`. So a later empty extraction **shadows** an earlier good one.

Both are worse under a voice form, where the input cost real money and the worker's time.

### The finding that reorders the plan

`target_kind` is read only for corpus validation and row→object pass-through. **Nothing branches on
`"attribute"` to route an answer anywhere**, and `answer-map-projector.ts` projects only RFS fields
through `FIELD_CROSSWALK`.

| `target_kind` | Items | Reaches `worker_profiles`? |
|---|---:|---|
| `rfs` | 107 (23%) | yes |
| `attribute` | **359 (77%)** | **no — silently dropped** |

Verified three further ways at the time: no matching code read the answer map, there was no
`worker_attributes` table, and nothing outside `apps/api/src/profiling/` read `answerMap`. Top
dropped fields: `workplace_type` (100), `tools_owned` (99), `safety_training` (17), `shift_work`
(14) — 80 distinct keys in all.

In voice this is worse than in chat: a session asks ~13 questions, ~8–9 of them `attribute`-kind, and
each spoken answer costs a paid STT call and the worker's time in a noisy yard before being discarded.

**Status: half closed.** The owner ruled a `worker_attributes` table and it shipped in V1 (migration
0071), so the destination now exists. The projector still does not write to it — that is V2, and
until V2 lands the 77% is still dropped.

---

## 1. Architecture

### Target flow

```
worker taps "Sawaal-jawaab"
  → [app] quiet-place pre-flight: permission ONCE, noise floor calibrated
  → [api] POST /profiling/session          → openTurn() → Q1, no takeTurn("")
  ↻ per question:
      [app] question rendered + TTS (pre-rendered asset) ─┐
      [app] mic already live (started BEFORE render)       │ mutually exclusive
      [app] endpointer detects end of speech ──────────────┘
      [app] clip → signed PUT → POST /profiling/answer
      [api] transcribe (SYNC, ≤30s → single Sarvam call) → text
      [api] ProfilingOrchestrator.takeTurn({ text }) → next question
  → [app] review screen → submit
  → [api] finalize → /profile/parse (THE ONE LLM CALL) → six gates → projector → worker_profiles
```

### The decisions that shape everything

**A. The voice form is the first live consumer of `ProfilingOrchestrator`.** The engine is built dark:
no controller, not in `app.module.ts`, and `ChatService.postMessage` still runs the v1 model-driven
path. Standing it up behind a *new* surface gives OIE a real consumer plus a per-surface rollback
lever (hide the screen) that the OIE plan says Phase 8 lacks.

This is **Phase 8a, not a shortcut** — it needs the same three legs Phase 8 needs (occupation pinning,
a finalize leg, a seeded DB) *plus* a mode-lock. Build the seam as a `ProfilingSessionService` both
surfaces can call, so Phase 8 becomes "point `postMessage` at the same service".

**B. Blocking per answer. Pipelining is impossible.** `captureAnswer(input.text, askedItem)` needs
answer *n*'s text, and `isSettled` (`next-question.ts:224`) is the first servability test — with the
answer missing, the engine re-serves the same question. Any concurrency model that assumes otherwise
is wrong. A client-side optimistic advance over a locally-known plan works for 99/101 packs and is
**V6 follow-on, gated on measured p95 > 6s**.

**C. Chips are required, not a preference.** 398 of 466 items are `boolean`/`single_select`/
`multi_select`, and `answer-capture.ts:129-150` has **no fuzzy speech→`option_key` path** — three
branches only: exact chip match → typed normalizer → verbatim fallback. Consequence: only ~5 of ~13
questions need STT, which cuts round-trips, cost and latency exposure by the same factor.

**D. Per-answer cap is 30s, not 120s.** At ≤30s Sarvam takes a **single sync call** and never enters
the chunked path (`stt.py:426-442`). That removes the multi-minute latency ceiling, the 5-chunk cost
reservation, and the Devanagari-danda **chunk-seam** privacy gap entirely. The 120s contract constant
is untouched and never load-bearing.

**E. TTS is pre-rendered, never live.** Every string `TurnResult.reply` can take is static — verified
by enumerating all 7 assignment sites; `input.text` never reaches `reply`. So no worker data crosses
the TTS boundary, and the audio is an asset, not a request. **But the reply set ≠ the pack strings:**
`joinClarify` (`orchestrator.service.ts:542-547`) concatenates `why_text + " " + prompt_text` at
runtime — **145 composed strings, ~52% of the corpus**, in no pack field. The renderer must enumerate
*reply producers* and content-address by `sha256(normalize(text))`.

**F. Object keys stay opaque.** `voice-notes/{workerId}/{uuid}.m4a`, unchanged. A semantic path would
ship `question_key` to Sarvam as a multipart filename (`stt.py:170-173` derives it from the basename)
and reopen the IDOR that `voice.service.ts:84-89`'s anchored regex closed. All semantics go in DB
columns. Keeping it **worker-prefixed** is what makes the DSAR orphan fix a one-liner.

### Repo corrections this plan depends on

- `packages/db/src/schema.ts` no longer exists — it is a directory of 11 modules re-exported by
  `src/schema/index.ts`.
- The table count is **62** (`schema` barrel; `tests/e2e/rls-spine.e2e.test.ts` asserts the two sets
  are equal). A new table makes it 63 **in three places**.
- **There is no `docs/decisions/`** — `git ls-tree HEAD docs/` returns only `docs/sprint-plans`. Every
  ADR reference in code comments (ADR-0003, ADR-0026, ADR-0029…) is a dangling link. What would
  normally amend ADR-0029 is recorded here instead.

---

## 2. Module ownership

Per CLAUDE.md §5/§6. Each owner takes complete modules end to end.

| Path | Owner |
|---|---|
| `apps/api/src/profiling/**`, `apps/api/src/voice/**`, `apps/api/src/chat/**` | Prakash |
| `packages/db/src/schema/profiling.ts`, migration 0071 | Prakash |
| `apps/ai-service/app/tts.py`, `cli/tts_smoke.py`, `cli/tts_render.py` | Divyanshu |
| `packages/db/data/question-packs/**` + pack tooling | Divyanshu |
| `apps/worker-app/**` | **Rishi** (issues #624–#639) |
| Compose / CI / secrets / bucket provisioning | Prakash (ops) |

Cross-team rule: backend never edits `apps/worker-app`; every client change is a GitHub issue.

---

## 3. Database changes — migration 0071 (SHIPPED)

**Landed as `0071_outstanding_monster_badoon`.** It was authored as `0070` and renumbered: PR #646
minted `0070_bent_storm` on a concurrent branch the same day, which is precisely the collision
`MIGRATIONS.md` exists to prevent. The lesson is recorded there in full, and it is worth repeating
here because this plan reasoned its way into the trap: **the collision risk is per concurrent
branch, not per person.** One developer running two sessions is two branches, and git warns nobody.

Renumbering meant **regenerating**, not renaming — a drizzle snapshot chains to its predecessor by
`prevId`, so a renamed snapshot would still have chained off `0069` and the next `db:generate` would
have emitted a migration to re-add `0070_bent_storm`'s columns. The regenerated SQL verified
byte-identical to the original apart from the hand-appended RLS tail, re-appended byte-for-byte.

Verified on a chain built from an **empty** database (standards invariant #10): the whole chain
applies clean, both new tables come up `ENABLE` + `FORCE` with zero grants for all three PostgREST
roles and zero policies, and every CHECK and partial unique index was exercised — each rejection
reporting the constraint that actually fired, so no constraint is decorative. The permanent form of
that is `tests/e2e/profiling-voice-spine.e2e.test.ts`.

### New table `worker_attributes` — the 77% finally has a destination

One live row per `(worker_id, attribute_key)`; a re-interview UPDATEs rather than accumulating.

| Column | Notes |
|---|---|
| `attribute_key` | The pack item's `target_field` — 80 distinct keys today. CHECK `^[a-z_]+$` len ≤40, the **same** filter `question_pack_item.question_key` carries, because this key reaches event payloads. |
| `value_kind` | `boolean` / `number` / `text` / `text_list`. Deliberately **not** the same axis as `answer_type`: eight answer types collapse into four storage kinds, so a new answer type does not force a migration. |
| `value_bool` / `value_number` / `value_text` / `value_text_list` | Exactly one populated, and `wa_value_present_chk` forces it to be **the one `value_kind` names**. Without that second half a row could claim `number` while carrying only text, and every reader trusting the kind would silently read NULL. `numeric(14,4)`, never float. |
| `source` | `answer_map` \| `llm_parse` — the projector's precedence outcome, recorded so an audit can answer "did a model write this?" without re-running the projection. Re-exported from `@badabhai/types`, so the vocabulary is not restated. |
| `question_key`, `pack_id`, `pack_version`, `session_id` | Provenance of the QUESTION. Pinned-together CHECK; `session_id` is SET NULL so the attribute outlives the session record. |

Indexes: UNIQUE `(worker_id, attribute_key)` — the core invariant and the upsert target — plus
`(attribute_key, value_bool)` for the matcher's "which workers have X" read. The per-worker read is
served by the unique index as a leftmost prefix, so no third index.

### New table `profiling_voice_answer` — in a new `packages/db/src/schema/profiling.ts`

One row **per recorded clip**. It is the *evidence*; the settled *value* belongs to the already-planned
`worker_pack_answer` (0075). Do not duplicate that.

| Column | Notes |
|---|---|
| `id` uuid PK | |
| `worker_id` → `workers` **CASCADE** | **Denormalized on purpose**: `voice_note_id` goes NULL on purge, and the row must stay worker-scoped after that. Postgres does not auto-index FK columns — `pva_worker_idx` is mandatory or the workers cascade seq-scans. |
| `session_id` → `chat_sessions` **CASCADE** | Session identity **is** the `chat_sessions` row. No second session table. |
| `voice_note_id` → `voice_notes` **SET NULL** | Mirrors `chat_messages.voice_note_id`: the capture fact outlives the purged clip. |
| `pack_id`, `pack_version` | Pinned **per row**, no FK — `qpi_pack_fk` is CASCADE, and retiring a pack version must not cascade into a worker's audit. |
| `question_key` | CHECK `^[a-z_]+$`, len ≤40 — mirrors `qpi_question_key_chk`, because this key reaches **event payloads**. |
| `attempt_no`, `ordinal` | Attempt = "Phir se bolein" counter. Ordinal = question position, repeats across attempts. |
| `capture_status`, `transcript_status` | Closed sets. |
| `duration_seconds` | Duplicated from `voice_notes` so retention analytics survive the purge. CHECK ≤120. |
| `superseded_at`, `superseded_by_id` | **Supersession as a fact, not a delete.** The audit survives a re-record. |
| `purged_at` | CHECK forces purge order: delete object → delete `voice_notes` row (FK nulls the ref) → flip status. |

### Indexes

| Purpose | Index |
|---|---|
| List a session's answers in order | `(session_id, ordinal, attempt_no)` |
| Attempt uniqueness | UNIQUE `(session_id, question_key, attempt_no)` |
| **Core invariant** — one live answer per question | UNIQUE `(session_id, question_key) WHERE superseded_at IS NULL` |
| Purge lookup + one clip ↔ one row | UNIQUE `(voice_note_id) WHERE voice_note_id IS NOT NULL` |
| DSAR enumerate | `(worker_id)` |
| Pending-transcription sweep | `(created_at) WHERE transcript_status IN ('pending','queued')` |
| **Retention sweep — a real gap on an existing table** | `voice_notes (created_at)` |

Take the `voice_notes` index **now**, while the table is empty (`VOICE_NOTES_BUCKET` is `""`, so the
surface is dormant). Drizzle wraps migrations in a transaction and `CREATE INDEX CONCURRENTLY` cannot
run inside one — this is the cheapest that index will ever be.

Do **not** add: a bare `(session_id)` (redundant leftmost prefix), `(question_key)` alone, or any
duplicate of `chat_sessions_worker_id_idx`.

### `chat_sessions` — two nullable pin columns

```sql
ALTER TABLE chat_sessions ADD COLUMN pack_id text;
ALTER TABLE chat_sessions ADD COLUMN pack_version integer;
-- + CHECKs: pinned-together, pack_id shape, version >= 1
```

**Why Redis alone is not sufficient.** The current trade (`chat-transcript.buffer.ts:30-35`) — "losing
Redis loses the conversation, the worker starts over" — was correctly priced when the only loss was
buffered text. A voice form makes the loss **asymmetric**: an eviction leaves durable `voice_notes`
rows and real m4a objects with **nothing in Postgres saying which question they answered**. The
`profiling_voice_answer` rows make resume reconstructible; the pack pin is the one thing they cannot
carry (eviction before clip #1 would re-run retrieval and could pin a *different* pack, silently
changing the questions mid-interview).

Write cadence: one extra UPDATE per recorded answer, 12–16 per session — nothing like the ~150 writes
the Redis buffer exists to avoid.

### RLS — two registrations, and the second is the one people forget

Posture is `ENABLE` + `FORCE` + `REVOKE ALL`, **zero policies** (deny-by-default; the backend runs
BYPASSRLS). Writing a permissive policy would change the platform posture and is an Architect +
security-engineer decision.

1. `tests/e2e/rls-spine.e2e.test.ts` `LOCKED_TABLES`
2. `packages/db/src/schema/index.ts` — import, `export *`, types, **and the `schema` barrel object**

`:148` asserts the list equals live `pg_tables`; `:149` asserts `live.size === Object.keys(schema).length`.
**62 → 64** in all three places (two new tables).

### Backward compatibility

Purely additive: 1 CREATE TABLE, 2 nullable ADD COLUMNs (metadata-only, no rewrite), 3 CHECKs (scan a
small all-NULL table), 7 CREATE INDEXes. **Zero drops, zero renames, zero mutated event payloads.**
Existing chat voice notes, `GET /voice/:id`, upload validation and the DSAR path are all unchanged —
the DSAR voice leg changes only to a **prefix sweep**, which deletes strictly more.

---

## 4. Phase plan

Complexity: S ≤2d, M 3–5d, L 6–10d, XL >10d.

### Phase V0 — Empirical gates *(Owners: Divyanshu + Prakash · S · **blocks everything**)*

**Objective.** Answer the two questions that can invalidate the design, for ~₹470 and one afternoon,
**before any UI is built**.

**Scope.**
- `apps/ai-service/app/cli/tts_smoke.py`, mirroring `stt_smoke.py`. 3×2 matrix (Roman/Devanagari ×
  `hi-IN`/`en-IN` × preprocessing on/off), 5 probe strings. `AI_REAL_CALL_TASKS=tts_synthesis` only.
- Field capture-rate run: 8 speakers × 8 `qp_universal` questions = 64 clips + a 16-clip adversarial
  tail. 3 quiet / 3 workshop / 2 outdoor; ≥2 speakers from cities outside the 36-entry gazetteer; ≥2
  with non-integer experience ("saade teen saal"); ≥1 negation. Recorded on a low-end Android with the
  **shipping `RecordConfig`**, piped through `stt_smoke --no-translate`, then each transcript through
  the **real `captureAnswer`**. Capture the amplitude envelope per clip so V6's endpointer can be tuned
  offline.

**Acceptance.** 30 TTS WAVs listened to by two native speakers. Scored capture table with
`captured_correct ≥70%` overall, **≥85%** on city/experience/salary/trade, **`captured_but_wrong ≤2%`**,
noise-cohort delta ≤15 points. p50/p95 STT wall-clock recorded.

**Abort criteria.** Roman-at-`hi-IN` worse than "intelligible" ⇒ a transliteration sidecar is required
first. `captured_but_wrong >2%` ⇒ a **per-answer confirm turn** is required, which changes the screen,
the cubit and the silence semantics — which is exactly why this runs before the UI.

> If `captured` is low while transcripts are near-perfect, the **lexicon** is the bottleneck, not the
> ASR — extend `cities.json` and re-score the same 80 transcripts offline for free.

---

### Phase V1 — Data spine *(Owner: Prakash · M · **DONE**, PR #647)*

Migration 0071 per §3 · `packages/db/src/schema/profiling.ts` · RLS registration in all three places
(62 → 64) · `MAX_PROFILING_ANSWER_SECONDS = 30` and the four closed-set vocabularies in
`@badabhai/types` · `VALUE_SOURCES` re-pointed at the shared definition rather than restated.

**Acceptance — met.** `tests/e2e/profiling-voice-spine.e2e.test.ts`, 12 cases against real Postgres:
a re-record supersedes rather than deletes, the partial unique index rejects two live answers for one
question, `value_kind` must name the populated column, the purge order is enforced, and the workers
cascade erases both tables. Every rejection asserts the **specific** constraint that fired.

**Deliberately not in this phase.** The DSAR prefix sweep and the retention-policy write move to V4
with the transcription seam — they are code on the write path, not schema, and the owner's
never-delete ruling makes the prefix sweep an erase-on-request concern rather than a retention one.

**Rollback.** Additive only — 2 CREATE TABLE, 2 nullable ADD COLUMN, 1 index on an empty table. With
no writer the schema is inert, so rollback is "revert the code, leave the schema".

---

### Phase V2 — Attribute projection *(Owner: Prakash · S · **DONE**, PR #651)*

Three changes, and the middle one turned out to be the largest missing piece in the whole design.

**1. `projectProfile` gained an attribute leg.** `ProjectionResult.attributes` carries
`{attributeKey, valueKind, value, source}` per non-RFS answer. **The crosswalk decides what is an
attribute** — `crosswalkFor` returns an entry for every RFS id and nothing else, so "no entry" *is*
"not RFS", and no `target_kind` had to be threaded down. `value_kind` is derived from the value's
SHAPE rather than from `answer_type`, so a new answer type needs no new case. The map-beats-LLM
precedence governs attributes identically — otherwise a model could overwrite a spoken answer in the
matcher's inventory while losing on the resume.

**2. A Hinglish yes/no reader (`parseAffirmation`), in the lexicon.** This is the piece nothing had.
All **236** `boolean` items carry **zero options** — measured, 236 of 236 — so there was never a chip
to tap, and capture fell through to its verbatim path and wrote "haan bilkul karta hoon" into a field
whose entire vocabulary is `true`/`false`.

Its three tiers are ordered *explicit yes → verb claim → bare negator*, and **measurement corrected
that order**: a negator scan placed ahead of the verb tier reads "kaam nahi mil raha, gas charging
karta hoon" as a `false`, because the negator belongs to a clause about work. The verb tier's own
check is clause-clamped, so asking it first gets that sentence right *and* still gets "nahi karta
hoon" right. The negative half is read from `negation.json` rather than restated — one negation
engine, not two.

**3. Select-option matching, with the destination deciding.** An `attribute` select that matches no
option captures **nothing**: `worker_attributes.value_text` is filtered by equality, so a sentence
there is not a worse value but an unmatchable one. An `rfs` select (41 of the 45 `multi_select` items
are `skills`) keeps the worker's words, because that destination is a free-form list the
canonicalization path already owns.

**Acceptance — met.** `boolean` items land as `true`/`false`, a negated yes lands as `false`, a hedge
captures nothing, refused options are dropped, and a contained label ("PVC" inside "CPVC") cannot
double-count. Each claim was mutation-verified: disabling the type layer reddens 11 tests, disabling
the attribute leg reddens 5, and reversing the affirmation tiers reddens the clause-clamping case.

**Deferred to V3 deliberately.** The `worker_attributes` *writer*. A repository with no caller is how
this engine got built dark the first time; it lands with the finalize leg that calls it.

---

### Phase V3 — Orchestrator surface *(Owner: Prakash · L · **DONE**, PR #650 → `2aa71d79`)*

> **Landed as the OIE Phase 8 cutover rather than as a parallel voice surface.** The plan bet on
> shipping the voice form as OIE's *first* live consumer, in parallel to an untouched chat. Running
> the engine proved that wrong-headed: `ChatService.postMessage` already owns the route, the auth
> guard and the ownership check, so a second surface would have duplicated all three to reach the
> same orchestrator. The cutover points `postMessage` at `takeTurn` and **deletes** the model-driven
> path — the rollback unit is a `git revert` of one PR, which is why every deletion landed in it.
> `ProfilingModule` therefore still has no controller, and the boot test now asserts that on purpose
> rather than as a symptom of being built dark.
>
> **Follow-on fixes the live run forced** — none of which 3,697 unit tests caught, because every one
> of them was found by *running the product*:
>
> - **#656** `catalogVersion()` is a ~75-char cache signature against a payload cap of 64, so the
>   event failed its own schema, threw inside the emitter, and **500'd `POST /chat/message` for
>   every worker whose trade did not resolve first try**. Also: event-validation diagnostics that
>   name the offending field (path + code only — zod echoes the rejected *value* in `issue.message`),
>   and compound chip labels (`"Loha ya mild steel"`) that dropped a material.
> - **#661** the pack pin (B-7) — see the Blocked table.
> - Two CI seed steps were passing while seeding **zero rows**: the seeders are dry-run by default
>   and `--apply` was missing. A green tick on a step that did nothing is worse than no step.
> - `worker_pack_answer` was never registered in the RLS drift guard's `LOCKED_TABLES`.

<details><summary>Original V3 scope, as planned</summary>

- `openTurn()` — a start route cannot call `takeTurn("")` (classifies `empty` → blank reply → unavailable)
- **Occupation pinning** — `OccupationService.resolve()` on the `primary_trade` answer writes
  `envelope.occupation`. **Never set `needsDisambiguation`**: `next-question.ts:326-337` returns
  `promptText: ""` and the guard fails closed → `UNAVAILABLE_REPLY` on **every** turn until Phase 7
  supplies chips.
- `answer_type: "boolean"` branch keyed on **type**, not `target_field` (all 236 boolean items carry
  zero options) + `multi_select` multi-value capture
- `ProfilingController` + `ProfilingSessionService`; `ProfilingModule` into `app.module.ts`; boot test
  **inverted, not deleted**, plus a positive assertion the module is in `AppModule.imports`
- **Mode-lock** (~6 lines): a session carrying a `profiling` envelope refuses `postMessage` and vice
  versa — closes the blind `save()` vs `saveWithCas()` lost-update hazard
- Finalize leg → `endSession` → messages (`message_type: "voice"`) → events → `/profile/parse` →
  second gate pass → `projectProfile`
- `whyText` on `TurnResult`; server maps `option_key → label_text`, **never the client**; 409 on a
  stale `question_key`

**Deliberately not built.** No client-callable `finalize` — completion is engine-authoritative.

**Acceptance.** A welding worker's session serves `qp_welding` items. **Path-equivalence test**:
identical text via the voice path and the chat path produces a deep-equal `TurnResult` — this makes
"both paths write the same profile" mechanical.

</details>

**Acceptance — measured live, not asserted.** `"main welder hoon"` → `jd_nco_7212_0301` via `l0_exact`
at 0.97 → `qp_welding` served → a 13-turn interview completes → **10 typed rows** in
`worker_pack_answer` (`certification=false` from "nahi hai", `safety_gear=true` from "haan li hai",
`workplace_type=factory`, `material_worked=["mild_steel","stainless"]`, `experience_years=8`) →
**0 events** containing a raw utterance or a phone number. `ai_posture: mock` throughout, so not one
word of it came from a model.

**Still owed from V3's scope:** the path-equivalence test — and note it is now a test of ONE path, since
the cutover deleted the model-driven one, so what it would pin is the pre/post-cutover branch inside
`extractOrParse` rather than two surfaces. The §1a convergence (B-6) is CLOSED: both legs reach
`ProfilesRepository.create`. `openTurn()`, the mode-lock and the 409-on-stale-`question_key` remain moot
until a second surface exists.

---

### Phase V4 — Transcription seam *(Owner: Prakash · M · **DONE** — defects PR #664 · seam PR #682)*

> **The defect half landed; the seam half has not.** All three bugs this phase named turned out to be
> the same mistake wearing three hats — *a failure recorded as a success* — and none of them needed
> the voice form to exist in order to bite. They bite the chat voice-note path today.
>
> - **`error_code` now crosses the wire.** `stt_budget_blocked` / `stt_call_failed` were logged on the
>   ai-service and dropped building the response, so three failures and one worker's silence arrived
>   at apps/api as the same empty string.
> - **A degraded result no longer completes the job.** It throws into the *existing* catch, so BullMQ
>   retries and only the final attempt writes the terminal record — one definition of "terminal",
>   not two.
> - **A fourth hole, found while fixing the third:** `AiService.transcribe`'s unreachable-service
>   fallback returned an empty transcript indistinguishable from silence, so an ai-service outage
>   read as a wave of quiet workers. It now reports `stt_service_unreachable`.
> - **The retry double-charge** is gated on `voice_notes.transcript_text IS NOT NULL` — compared
>   against null explicitly, because an empty string is a real transcript and cost the same as a
>   full one.
>
> **The seam half landed in #682.** `VoiceTranscriptionService` now holds everything that is not
> queue plumbing — idempotency, the provider call, the degraded-result decision, persistence and
> the terminal record — and `VoiceModule` gained the `exports` block it never had, so a second
> caller can reuse the sequence instead of forking it. The processor is 30 lines: the payload, the
> attempt arithmetic, the rethrow. `terminal` is passed IN as a policy input rather than derived,
> because "will this be retried?" is a fact only the caller knows — a synchronous caller passes
> `true`. Every pre-existing behavioural test still drives through `proc.process(...)`, which is
> what makes the suite a regression proof rather than a rewrite.
>
> The **DSAR orphan sweep** landed with it. `listVoiceStorageKeys` can only enumerate audio that
> has a ROW, and upload is two calls — a signed PUT, then a separate insert. A client that
> completes the PUT and never makes the second call left raw worker audio no row pointed at,
> invisible to the query, surviving erasure forever. Added BESIDE the per-row loop, never
> replacing it: legacy `storage_path` values predate the minted-key shape guard and sit outside
> `voice-notes/{workerId}/`.
>
> **Still not built, deliberately: the synchronous ≤30s path.** It has no consumer until V6 ships,
> its latency is B-3 (still unmeasured), and a config-gated route nothing calls is the "built
> dark" pattern this plan was written to stop repeating. The extraction above is what makes it a
> small change when V6 arrives.
>
> **`translate_to_english` is NOT flipped, and that is a deliberate hold.** Measured: apps/api
> sets it nowhere, so the ai-service default `True` governs and the translate leg fires on every
> transcription — real Sarvam spend on NO ledger (`translate.py` imports no cost tracker and takes
> no `worker_ref`), which is R9 recurring. Flipping it globally is not mine to do: `GET /voice/:id`
> returns `transcript_english` to an existing client, so `false` changes a shipped response. It
> belongs to the form surface when the form surface exists, or to an owner ruling. Dormant
> meanwhile — `VOICE_NOTES_BUCKET` is unset, so the leg fires zero times today.

<details><summary>Original V4 scope, as planned</summary>

- Extract `VoiceTranscriptionService` from the BullMQ processor; `VoiceModule` gains `exports`
- **Synchronous ≤30s answer path** (`PROFILING_ANSWER_MAX_SECONDS = 30`) — deletes the queue hop, the
  `ai_jobs` row, the poll loop and the TD59 strand for form answers. Keep the async path for the
  30–120s chat voice-note case.
- **Surface `error_code`.** `SttResult.error_code` (`stt_budget_blocked`, transport failure) is dropped
  at the contract boundary today, so the processor writes an empty transcript and marks the job
  `completed` — **a blocked answer is recorded as a successful transcription of silence.** In a
  voice-only form that is the worker speaking and their answer vanishing.
- **Idempotency fix.** The processor short-circuits on job status, but `markFailed` fires only on the
  final attempt — so a mid-retry job re-calls Sarvam. A 3-attempt retry of a 5-chunk note bills 15
  chunks. Gate on `voice_notes.transcript_text IS NOT NULL` instead.
- `translate_to_english: false` for this surface — the form wants the worker's own Hinglish back, and
  it deletes a 60s ceiling **and** an unledgered Sarvam call from the critical path.

</details>

---

### Phase V7 — Cost observability *(Owner: Prakash · **DONE**, PR #665)*

Run ahead of V5, because it turned out not to be about the voice form at all.

The plan's §7 note said "only `profile_extraction` persists cost". Measuring it found something
sharper: **the cutover's own LLM call was invisible in three independent ways**, so every number the
ledger could produce described the architecture the cutover deleted.

| | |
|---|---|
| `/profile/parse` returned no `ai_metadata` | nothing downstream *could* record it |
| `aiTaskType` listed 3 of the 8 task types the service charges against | and `ai.cost_recorded`'s emitter swallows validation errors, so an unlistable task produced **nothing**, not a rejection |
| the emitter hard-coded `profile_extraction` and keyed on `ai_job_id` | one job now makes two billable calls, so the second was silently deduped away |

Pinned by a test that reads the enum out of `payloads.ts` and compares it to the service's own
`STT_TASK_TYPE` / `TTS_TASK_TYPE` / `EMBEDDING_TASK_TYPE` / `PARSE_TASK_TYPE` constants, so the next
provider surface cannot arrive unledgered.

**Still open from §7:** `SpendLedger` remains a Redis rate-limiter with expiring keys rather than a
ledger. The `events` table is now the cost history — every real call emits `ai.cost_recorded` — which
is the cheaper answer than a new table and matches §3 ("events are the audit trail"). The remaining
gap is the **translate leg**, which is real Sarvam spend that fires by default and is on no ledger at
all; setting `translate_to_english: false` for the form path deletes it from that surface but not
from chat.

---

### Phase V5 — TTS pipeline *(Owner: Divyanshu · L · **enumeration DONE**, PR #667 · render still after V0)*

> **Split, because only half of it depends on the listening test.** *What* to render is a property
> of the engine; *how it should sound* is the open question B-2 answers. The first half shipped.
>
> **Measured over the real corpus** — the closure is not the pack strings:
>
> | producer | distinct clips |
> |---|---:|
> | `prompt` | 129 |
> | `retry` | 4 |
> | `why` (bare — reachable when the served question is gone) | 143 |
> | `clarify` (`why_text` + `servedText`) | 150 |
> | `constant` | 7 |
> | **total** | **433** |
>
> The plan estimated 145 clarify strings; it counted why+prompt only. A worker can ask "why?"
> *after* the re-ask too, so why+retry is a distinct thing to say.
>
> **A defect the enumeration exposed.** Deciding which question text pairs with a `why_text` forced
> the question, and the answer was wrong: `joinClarify` read `askedItem.prompt_text` raw, while the
> silent-turn branch carries a comment about that exact mistake. A worker looking at the re-ask who
> then asks "yeh kyun poochh rahe ho?" got the explanation followed by the phrasing from two turns
> ago. Five of 466 items carry `retry_text` today, which is why it survived.
>
> **The placeholder guard landed** in `validateQuestionPackCorpus` — already a CI gate via
> `db:verify:packs --corpus` — across all three served fields, with `assertNoInterpolation` as the
> second wall inside the closure. Measured: 0 of 466 items carry a template token today, so it is a
> guard and not a repair.
>
> **Still owed:** `tts_render.py` over the closure, the golden closure file asserted from both TS
> and Python (the `normalize()` parity vectors), and the boot test that no FastAPI router imports
> `tts_adapter`. All three are cheap once B-2 says whether the corpus needs a transliteration
> sidecar.

- `app/tts.py` — `TtsAdapter`, `TTS_TASK_TYPE = "tts_synthesis"` (**its own allowlist key**, so TTS can
  be flipped independently of STT), gate chain mirroring `stt.py:207-248` **in order**, fail-closed to
  empty audio, ledgered with `user_ref=None` (operator spend, not worker spend), PII-free logging.
- `cli/tts_render.py` — batch renderer over the packs **plus the 145 `joinClarify` concatenations plus
  the 6 fixed constants** (~508 clips), content-addressed `sha256(normalize(text))[:16]`.
- Golden closure file asserted from **both** TS and Python; `normalize()` parity proven by explicit
  char-class golden vectors, never `\s`.
- **Boot test: no FastAPI router imports `tts_adapter`.** The wall is structural — TTS is reachable
  only from the CLI, so no dynamic text can ever reach it.
- Corpus validator rejects `{{…}}` in any served text. **The highest-value two-line validator here**: a
  shared pre-rendered cache serving one worker's interpolated name to every other worker is the worst
  failure in this design, and post-emit `{{worker_name}}` is exactly the mechanism.

---

### Phase V6 — Flutter client *(Owner: Rishi · XL · #624–#639)*

Full issue list in GitHub. **Backend contracts must be frozen before #628–#632 start**, or the mock is
fiction. #624, #625, #626 have no backend dependency and can start immediately.

Scope: `lib/features/voice_form/` · a **separate** `SessionVoiceRecorder` binding (the existing
recorder is a process-wide `LazySingleton` shared with the single-shot flow) · a pure-Dart endpointer ·
pre-flight calibration · question screen · chips · TTS playback · review screen · offline queue ·
the TD59 client half.

---

### Phase V7 — Cost observability *(Owner: Prakash · M · parallel with V4/V5)*

**There is no cost history today.** `SpendLedger` is a Redis rate-limiter whose keys expire ~25h after
the day they describe; only `profile_extraction` writes a durable cost row. Voice would record none of
its spend, and `aiTaskType` cannot even express `stt_transcription`.

Minimum that must ship **with** the feature, because the feature creates the spend:
- `ai_provider_calls` table, grain **one row per provider call**, `numeric(12,4)` for money (not
  `doublePrecision` — `ai_jobs.cost_inr` drifts under `SUM()`), idempotent on `ai_call_id`
- Split `cost_inr` (real, **0 for mock**) from `projected_cost_inr` — mock calls currently report
  non-zero cost, so `SELECT sum(cost_inr) FROM ai_jobs` is phantom money
- STT/TTS return `ai_usage[]` across the contract boundary
- Widen `aiTaskType` (additive enum widening — **Architect ruling**, CLAUDE.md §3)
- Two read routes only: session cost and rollup, under `AdminAuthGuard` + `read_entities`

Deferred: the other read routes, anomaly detection, the provider circuit breaker, rate recalibration.

---

### Phase V8 — Staging Sarvam flip *(Owner: Prakash (ops) · M · after V0/V4/V5)*

**TTS first.** Outbound-only, zero worker data, no consent conversation. Never arm both providers in
one change — an incident you cannot bisect is not a flip.

Gates: signed Sarvam DPA · bucket provisioned private · **`VOICE_NOTES_BUCKET` split-brain killed**
(API defaults `""`, ai-service defaults `"worker-voice-notes"`; a mismatch is silent total failure with
a green `/health`) · `AI_INTERNAL_TOKEN` armed **both** sides · **compose + CI pass-through wired** —
neither compose file declares `SARVAM_API_KEY`, `SUPABASE_*`, `VOICE_NOTES_BUCKET` or
`AI_REAL_CALL_TASKS`, so **the flip is a 4-artifact code change, not an env action** · translate leg
ledgered or disabled · DSAR prefix sweep · **ASR PII measurement** (if saarika emits digits as words —
"nau aath saat" — *no gate in the system fires* and a phone number reaches the LLM) · B-1 done · root
`.env.example` corrected (it says "EMPTY = all tasks"; the enforcing code says empty = **nothing**
allowed — **inverted in the fail-open direction**).

Abort: any `is_mock=True` on a real rung · `stt_call_failed` >5% · p90 > client budget · `captured_but_wrong` >2%.

---

### Phase V9 — GA gates *(Owners: joint · L · after V8)*

`voice_processing` consent purpose **plus a purpose-aware guard** (`ConsentGuard` is purpose-blind
today, so the purpose alone is decorative) · DPDP notice copy naming recording, the third-party
processor, the retention period and the training-use boundary · consent version bump + re-consent ·
**TD58 purge job** · TD59 · R30 reassessed against measured ASR output.

**TD58 is re-scoped from compliance debt to a launch gate.** ~16 objects and 4–5 MB of raw voice PII
per worker per session; ~450 GB at 100k workers, hot tier, retained indefinitely, no purge job. That
was tolerable when voice was an optional chat extra. It is not, once a form makes voice the primary
capture path. **Do not set `VOICE_NOTES_BUCKET` on this path until a purge job exists.**

---

## 5. Dependency graph

```
V0 Empirical gates (TTS roman-script + capture rate)  ── BLOCKS EVERYTHING ──┐
        │                                                                    │
        ├──────────────► V5 TTS pipeline (Divyanshu) ────────────┐           │
        │                                                        │           │
   B-1 packs seeded ──► V1 Data spine (0071) ✅ ──┬──► V3 Orchestrator surface ─┤
                                               │                             │
                                               └──► V4 Transcription seam ───┤
                                                                             │
                        V2 Attribute destination  ← OWNER DECISION           │
                                                                             │
   V7 Cost observability (parallel) ─────────────────────────────────────────┤
                                                                             ▼
                        contracts frozen ──► V6 Flutter (#624-#639, Rishi)
                                                        │
                                                V8 Staging flip
                                                        │
                                                  V9 GA gates
```

**Sync points:** end of **V0** (design survives or does not) · **contracts frozen** after V3/V4
(before Rishi's #628–#632) · **V8** (joint).

---

## 6. Testing

Gates: build · lint · oxlint · typecheck · coverage 75/75/73/75 (**never lowered**) ·
`db:verify:packs --corpus` · ruff + pytest · `flutter analyze`/`test` · e2e from a scratch chain.

**Three CI holes this feature straddles** — confirm each job *fired*, do not infer from a green tick:
1. `packages/db/data/question-packs/**` is **not** in the ai-service paths filter — add it.
2. A worker-app-only change runs neither ai-service nor e2e.
3. Copy the `RUN_DB_TESTS` did-it-actually-run assertion for any new opt-in suite, or it passes vacuously.

**Local hazard:** 13 stale worktrees under `.claude/worktrees/` sit inside the vitest glob, so a local
full-suite run collects abandoned branches and reports failures that do not exist. CI is unaffected.

Privacy assertions, each with a mutation that proves it bites: TTS text never logged (stub the
transport to raise `RuntimeError(QUESTION_TEXT)` — `stt.py:366` logs `str(exc)`) · transcript never in
the new events · audio path never logged (**expect this to fail today** — a Supabase 404 typically
embeds the object key) · the pre-rendered TTS route takes `question_key`, never free text.

---

## 7. Risk register

| # | Risk | Consequence | Mitigation |
|---|---|---|---|
| R1 | **77% of items have no destination** | The form asks ~8–9 questions per session and discards the answers, each a paid STT call | **V2 — owner decision** |
| R2 | Packs in git, in no database | Every worker gets `UNAVAILABLE_REPLY`, silently | B-1 + boot-time `loadUniversal()` ERROR log; seed step in `staging-cd.yml` |
| R3 | Sarvam TTS on romanized Hinglish | Confident nonsense in an English voice is worse than silence for a non-reader | **V0 rung 0** before anything is built |
| R4 | Round-trip latency unmeasured; only bound in code is 10× the client budget | The "seamless" promise cannot be made | V0; chips remove 85% of round-trips, which is the real mitigation |
| R5 | `envelope.occupation` never written | 100 trade packs unreachable | V3 |
| R6 | Reply closure ≠ pack strings (145 concatenations) | Pre-render misses ~52%; every clarify turn falls through to a live TTS call | Enumerate reply *producers*, content-address |
| R7 | Recorder is a process-wide `LazySingleton` | "Single-shot flow unchanged" is false by construction | Separate `SessionVoiceRecorder` binding (#625) |
| R8 | Silence detection unmeasured, no repo precedent | Too eager cuts the worker off; too lax makes the manual button the only advance | Amplitude envelope captured in V0; pure-Dart endpointer, synthetic-stream testable |
| R9 | Translate leg is real Sarvam spend **not on the ledger**, fires by default | ~13 unbudgeted calls/session — the TD68 defect class recurring | V4: `translate_to_english: false` |
| R10 | Degenerate-turn cost ceiling | `MAX_ENGINE_TURNS = 171` × ₹0.25 = ₹42.75, 171% of the per-worker daily cap, which is *shared* with chat + resume | Cap **billed clips per session**; the engine's ask budget does not bound clips |
| R11 | No worker has ever consented to being recorded | GA blocker | V9 |
| R12 | `mintLink` builds `/r/` URLs | Dormant — **no production caller**; verified, not assumed | Leave as measurement-only |

---

## 8. Reuse ledger

Reused unchanged: the deterministic engine · the 101 packs · pack tables + seeder + validator · the six
gates and their Python mirror · `FIELD_CROSSWALK` · the projector · `/profile/parse` · the Sarvam STT
adapter and chunker · `stt_smoke.py` · the spend ledger · the signed-upload seam and its IDOR guard ·
`voice_notes` · the DSAR erase leg · the Flutter recorder, permission and temp-clip hygiene · the
design-system primitives · the Hinglish copy constants · persona guards (client + server) · the remote
-config kill-switch pattern · the event spine.

Net-new: `worker_attributes` + `profiling_voice_answer` + migration 0071 · `ProfilingController`/`ProfilingSessionService` ·
`openTurn` · occupation pinning · boolean/multi-select capture · `VoiceTranscriptionService` + the sync
short-answer path · `app/tts.py` + the two CLIs + the rendered corpus · `ai_provider_calls` ·
`lib/features/voice_form/` · 4 additive event payloads.

---

## Critical files

| Concern | Path |
|---|---|
| Question engine (pure) | `apps/api/src/profiling/next-question.ts` |
| Turn driver | `apps/api/src/profiling/orchestrator.service.ts` |
| Answer capture | `apps/api/src/profiling/answer-capture.ts` |
| Projector (the 77% gap) | `apps/api/src/profiling/answer-map-projector.ts` |
| Packs | `packages/db/data/question-packs/packs/*.json` |
| Voice upload/transcribe | `apps/api/src/voice/**` |
| Sarvam STT | `apps/ai-service/app/stt.py` |
| Spend ledger | `apps/ai-service/app/ai/cost_tracker.py` |
| Real-call gate chain | `apps/ai-service/app/config.py` |
| DSAR voice leg | `apps/api/src/auth/account-deletion.service.ts:204-259` |
| Flutter recorder | `apps/worker-app/lib/features/voice/data/record_package_voice_recorder.dart` |
| RLS drift test | `tests/e2e/rls-spine.e2e.test.ts` |
| Migration blocks | `MIGRATIONS.md` |
