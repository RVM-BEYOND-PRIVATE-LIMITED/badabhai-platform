# Voice Profiling Form — Implementation Plan

Hinglish voice-driven sequential Q&A for the worker app: questions shown one at a time, read aloud,
answered by speaking or by tapping a chip, in one sitting. Sarvam STT in, Sarvam TTS out.

**Status date:** 2026-08-07 · **HEAD:** `7502a09c`

---

## Status

### Shipped

| What | Where | State |
|---|---|---|
| Silent-turn blank-reply fix + `servedText` re-serve | PR #641 → `2d4354ac` | **on `main`** |
| Desktop bridge QR pointed at `/i/` (closes #607) | PR #642 → `7502a09c` | **on `main`** |
| 16 worker-app issues, assigned RishiBamako | #624–#639 | **filed, open** |

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
| **B-4** | Where `attribute` answers land | **No destination exists.** See V2. |
| **B-5** | `envelope.occupation` is never written | The 100 trade packs are unreachable; every worker gets the 8-item universal tail. V3. |

### The finding that reorders the plan

`target_kind` is read only for corpus validation and row→object pass-through. **Nothing branches on
`"attribute"` to route an answer anywhere**, and `answer-map-projector.ts` projects only RFS fields
through `FIELD_CROSSWALK`.

| `target_kind` | Items | Reaches `worker_profiles`? |
|---|---:|---|
| `rfs` | 107 (23%) | yes |
| `attribute` | **359 (77%)** | **no — silently dropped** |

Verified three further ways: no matching code reads the answer map, there is no `worker_attributes`
table, and nothing outside `apps/api/src/profiling/` reads `answerMap`. Top dropped fields:
`workplace_type` (100), `tools_owned` (99), `safety_training` (17), `shift_work` (14).

In voice this is worse than in chat: a session asks ~13 questions, ~8–9 of them `attribute`-kind, and
each spoken answer costs a paid STT call and the worker's time in a noisy yard before being discarded.
**V2 exists to close this, and it is an owner decision.**

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
| `packages/db/src/schema/profiling.ts`, migration 0077 | Prakash |
| `apps/ai-service/app/tts.py`, `cli/tts_smoke.py`, `cli/tts_render.py` | Divyanshu |
| `packages/db/data/question-packs/**` + pack tooling | Divyanshu |
| `apps/worker-app/**` | **Rishi** (issues #624–#639) |
| Compose / CI / secrets / bucket provisioning | Prakash (ops) |

Cross-team rule: backend never edits `apps/worker-app`; every client change is a GitHub issue.

---

## 3. Database changes — migration 0077

`0077`, the first free slot in Prakash's `0075–0079` block. **Re-derive from `_journal.json` at
generate time** — head is `idx 69` today, and `pnpm db:generate` numbers from the head, so if
0070–0076 have not landed it will emit `0070` and must be renumbered per `MIGRATIONS.md:66-70`. The
clean sequencing is to land this **after** 0075/0076. Claim the row in `MIGRATIONS.md` in the same PR.

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
**62 → 63 in all three places.**

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

### Phase V1 — Data spine *(Owner: Prakash · M · after V0)*

Migration 0077 per §3 · `packages/db/src/schema/profiling.ts` · RLS registration in both places ·
DSAR voice leg per-key → **prefix sweep** · `retentionPolicy: 'delete_after_processing'` on the form's
register path.

**Acceptance.** `rls-spine` e2e green at 63 tables. An orphaned object (PUT without register) is
erased by DSAR. A re-record supersedes rather than deletes, and the partial unique index rejects two
live answers for one question.

**Rollback.** Before any clip: fully reversible. After clips exist: revert code, leave schema (this
repo has no down-migrations; additive schema with no writer is inert).

---

### Phase V2 — Attribute destination *(Owner: Prakash + **owner decision** · M · after V1)*

**Objective.** Give the 359 `attribute`-kind answers (77% of the corpus) somewhere to land. Without
this the voice form asks ~8–9 questions per session whose answers are discarded at projection.

**The decision (owner's, not engineering's).** A `worker_attributes` table · a JSONB column on
`worker_profiles` · extend the RFS vocabulary + crosswalk · or rule attributes deliberately
measurement-only — **in which case the voice form must not ask them**, and the packs need a
`skip_in_voice` flag.

**Blocks.** The *value* of V3–V6. The form is buildable without it; it just wastes 77% of the questions.

---

### Phase V3 — Orchestrator surface *(Owner: Prakash · L · after V1)*

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

---

### Phase V4 — Transcription seam *(Owner: Prakash · M · after V1)*

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

---

### Phase V5 — TTS pipeline *(Owner: Divyanshu · L · after V0)*

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
   B-1 packs seeded ──► V1 Data spine (0077) ──┬──► V3 Orchestrator surface ─┤
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

Net-new: `profiling_voice_answer` + migration 0077 · `ProfilingController`/`ProfilingSessionService` ·
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
