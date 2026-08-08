# Occupation Intelligence Engine — Implementation Plan

## Context

BadaBhai profiles blue-collar workers who have no resume. The profiling conversation is the only source of
truth for everything downstream: the resume, the match engine, and the ranking.

The current branch (`feat/ai-chat-profiling`, commit `fc95d2f`) deleted a 923-line deterministic interview
engine and a 632-line question bank and replaced them with an LLM that writes its own question every turn.
That solved a real problem — the question bank covered 7 hardcoded trades and a tailor got asked CNC
questions — but it bought coverage by handing conversational control to a model, which conflicts with
CLAUDE.md §3 ("AI never owns business decisions") and costs one `capable`-tier call per turn.

**This project restores determinism without restoring the hardcoding.** The question set is no longer code:
it is data, bound to a published occupation taxonomy (NCO-2015/ISCO-08, already seeded — 4,071 occupations).
The orchestrator picks the next question deterministically; retrieval identifies the occupation from the
worker's own words; the LLM is called exactly **once**, at the end, and only to parse a transcript into
strict JSON.

The economic case is direct: **~12 `capable` calls per interview → 1.**

### Five findings from the corpus that change the premise

Verified by running the seed files, not assumed:

| # | Finding | Consequence |
|---|---|---|
| **F1** | `label_hi` is NULL for all 4,071 rows | No Hindi labels exist to show a worker |
| **F2** | All 8,695 aliases are `lang:"en"` | Zero vernacular surface |
| **F3** | 77% of selectable occupations have exactly **one** alias — the official English title | `"Welder, Gas"`, `"Cook, Domestic"`, `"Assistant Mason"` |
| **F4** | All 436 ISCO unit groups are `selectable=true` alongside 3,449 NCO occupations; **370 are shadowed** by NCO children | The shortlist mixes two granularities |
| **F5** | `industry_id` is NULL for all 4,071 rows | No industry-scoped retrieval today |

**The headline:** a worker saying *"kharad ka kaam karta hun"* matches nothing in the current catalogue.
The status doc's P0 — embedding the 8,695 aliases — buys a semantic index over English government job
titles. At ~12 tokens each that backfill costs **~₹2**, not a spend decision. **The real P0 is authoring the
vernacular alias layer, which does not exist.**

### Decisions taken (user, this session)

1. **Hard cutover on this branch** — no dual-path flag. The LLM interview modules are deleted in the same
   phase that wires the replacement (Phase 8), atomically, after every gate passes. Phases 0–7 build the new
   engine as unreferenced-but-tested modules, so no intermediate phase leaves the repo broken.
   *Stated concern, for the record:* there is no per-trade rollback lever once flipped; the rollback unit is
   `git revert` of the Phase 8 PR. Phase 9's calibration gates are what de-risk this, and they are
   non-optional as a result.
2. **Question packs: JSONL in git → seeded into versioned DB tables.** Same discipline as job-domains today.
3. **Vernacular aliases: both sources** — LLM-generated offline with human review, *and* mined from real
   `chat_messages`. Both land in one reviewable JSONL corpus.
4. **Pack coverage: all ~200 blue-collar families** (ISCO majors 5–9: 2,156 occupations, 199 unit groups)
   before launch. This is the schedule's long pole and gets its own parallel track (Phase 6).

---

## 1. Architecture Review

### Target flow

```
worker message
  → [Nest] Orchestrator: load envelope (Redis, CAS on rev)
  → [Nest] answer-capture: deterministic detectors → AnswerRecord (valueRaw + valueNormalized + evidence span)
  → [Nest] Retrieval Engine (only while phase=IDENTIFY): L0 exact → L1 skeleton → L2 trigram → L3 vector
  → [Nest] occupation pinned → question pack pinned (pack_id, pack_version) — IMMUTABLE for the conversation
  → [Nest] next-question(): PURE function (envelope, pack) → {ask | disambiguate | clarify | close}
  → [Nest] CAS save, return reply + chips
  ... repeat, ZERO LLM CALLS ...
  → completion → one Postgres transaction (existing finalizeInterview shape)
  → BullMQ → [ai-service] POST /profile/parse — THE ONE LLM CALL
  → six provenance gates → AnswerMapProjector precedence → worker_profiles
```

### The three decisions that shape everything

**A. The orchestrator lives in NestJS `apps/api/src/profiling/`, not the Python service.**
Question selection is a business decision (CLAUDE.md §4: business logic in Services). The ai-service is
deliberately DB-free — `domain_match.py:98-100` states it, and every lookup today is
`ai-service → HTTP → api → Postgres → back`. The orchestrator needs the DB on every turn. Events are
Nest-native (`EventsService.emit` supports `tx` + `idempotencyKey`). The Redis buffer and the
API-authoritative turn cap are already Nest-owned. After this, the ai-service holds exactly three jobs:
**pseudonymize, embed, parse** — a far cleaner boundary than today's.

**B. Resolve the FAMILY first, the occupation second.**
NCO is over-granular for conversation: `"Welder, Gas"` vs `"Welder, Electric"` is a ~0.02 margin at
occupation level and **0.00 at family level** — they share a question pack. Computing the accept margin at
family level is what makes 3,449 near-duplicate occupations survivable. The exact NCO code is then settled by
the pack's own first question ("Gas welding karte ho ya arc?") — deterministic, free, and better UX than a
disambiguation prompt listing 44 titles.

**C. Lexical-first retrieval; vectors are a quality upgrade, not the critical path.**
0 of 8,695 aliases are embedded and `nearestDomains` filters `embedding IS NOT NULL`, so the product must
work with vector retrieval off. That is a hard constraint, not a preference.

| Layer | Method | Cost | Latency |
|---|---|---|---|
| **L0** exact | normalized alias hash lookup | free | ~2 ms |
| **L1** skeleton | Hinglish confusion folding (`kh↔k`, `aa↔a`, `w↔v`, `z↔j`, `sh↔s`) — fixes *welder/waelder/velder*, *kharad/kharaad* | free | ~2 ms |
| **L2** trigram | `pg_trgm` `word_similarity` over `text_norm` | free | ~15 ms |
| **L3** vector | pgvector ANN via `embed_text` | 1 embed call | ~290 ms |

Target after the alias overlay: **L0+L1 ≥ 45%, L2 ≥ 30%, L3 ≤ 25%**, and **≤400 ms p95 per deterministic
turn with zero LLM calls**.

### Live defects this project fixes

| Defect | Evidence | Fixed in |
|---|---|---|
| `captured` never reaches extraction — "the single largest unresolved design question" | `ProfileExtractionInputSchema` has no `captured` field; extraction re-parses the transcript under a *different* vocabulary (`trade`→`primary_role`, `salary_expected`→`expected_salary`) | Phase 7 — `answer_map` is the parse call's *primary* input, plus a `FIELD_CROSSWALK` with an exhaustiveness test |
| `/profile/extract` fails closed on any verbose interview | `main.py:970` pseudonymizes the whole concatenated transcript; `pseudonymize.py:448` blocks >20,000 chars. 30 turns × ~340 chars already exceeds it → empty profile, no explanation | Phase 7 — the new route pseudonymizes **per message** (≤4,000 chars each); a blocked line is dropped and counted, never fatal |
| `nearestDomains` cannot use its own HNSW index | `skills.repository.ts:72` leads `ORDER BY` with `a.job_domain_id`, not the distance — HNSW only accelerates `ORDER BY embedding <=> $q LIMIT n`. Full scan + full sort, then JS `.sort().slice()` at `:79-82`. No SQL LIMIT | Phase 1 — two-stage ANN-first CTE |
| Redis buffer lost update | `load → mutate → save` with no concurrency guard | Phase 5 — Lua CAS on a monotonic `rev` |
| `verify-job-domains.ts` "catalog is empty" check is inert | a count of 0 short-circuits to PASS | Phase 1 |
| Transcript buffer failing the shape check lingers to TTL | treated as absent but not deleted | Phase 5 |
| `chat_messages` missing `(session_id, created_at)` index | `chat.repository.ts:91-96` filters+sorts+limits on exactly that | Phase 1 |
| `job_domain_alias` has no unique constraint; 1 known duplicate (`jd_nco_8154_0300`) | idempotency rides only on the deterministic alias UUID | Phase 1 |
| `worker_profiles` not `.enableRLS()` | one of the few tables without it | Phase 8 |
| Migration 0066 documented as "0060" in ~8 places | renumbered in `88cb536`, comments not updated | Phase 0 |

---

## 2. Module Ownership

Split by bounded context. Each developer owns complete modules end-to-end.

### Divyanshu — **Occupation Intelligence (data plane)**
Modules 1 (Taxonomy Service) + 2 (Retrieval Engine). Owns the catalogue, the aliases, the families, the
packs, and every query that reads them.

### Prakash — **Conversation & Profiling (control plane)**
Modules 3 (Orchestrator) + 4 (Profiling Engine) + 5 (Final Parsing LLM). Owns the turn loop, the state
machine, answer capture, persistence, and the single LLM call.

### Folder ownership map

| Path | Owner | Module |
|---|---|---|
| `packages/db/data/job-domains/**` | Divyanshu | Taxonomy corpus |
| `packages/db/data/question-packs/**` *(new)* | Divyanshu | Pack corpus |
| `packages/db/src/job-domain-*.ts`, `seed-job-domains.ts`, `verify-job-domains.ts`, `audit-job-domains.ts`, `embed-job-domain-aliases.ts` | Divyanshu | Taxonomy tooling |
| `packages/db/src/question-pack-corpus.ts`, `seed-question-packs.ts`, `verify-question-packs.ts` *(new)* | Divyanshu | Pack tooling |
| `packages/db/src/schema/occupation.ts`, `schema/question-pack.ts` *(new, post-Phase-0 split)* | Divyanshu | Taxonomy schema |
| `apps/api/src/occupation/**` *(new)* | Divyanshu | Taxonomy Service + Retrieval Engine |
| `apps/api/src/skills/skills.repository.ts` | Divyanshu | Retrieval (shared file — see protocol) |
| `packages/profiling-lexicon/src/normalize/**` *(new)* | Divyanshu | Occupation text normalization |
| `apps/api/src/profiling/**` *(new)* | Prakash | Orchestrator |
| `apps/api/src/chat/**` | Prakash | Turn loop |
| `apps/api/src/profiles/**` | Prakash | Profiling Engine |
| `apps/ai-service/app/routers/parse.py` *(new, post-Phase-0 split)* | Prakash | Final Parsing LLM |
| `apps/ai-service/app/parsing/**` *(new)* | Prakash | Parse gates + prompts |
| `apps/ai-service/app/profiling/signals.py` | Prakash | Lexicon source (read-only after Phase 3) |
| `packages/profiling-lexicon/src/{predicates,values}/**` *(new)* | Prakash | Hinglish detectors + value normalizers |
| `packages/db/src/schema/chat.ts`, `schema/profile.ts` *(post-Phase-0 split)* | Prakash | Conversation schema |

### Shared paths — change protocol

These four files are the merge-conflict hotspots. **Phase 0 splits three of them and freezes the fourth.**

| Shared path | Protocol |
|---|---|
| `packages/ai-contracts/src/**` | Split into modules in Phase 0, then **frozen**. Any change after Phase 0 requires a joint PR reviewed by both, mirrored in `apps/ai-service/app/contracts.py` **and** `__fixtures__/profiling.keys.json` in the same commit — `test_contract_parity.py` turns red if one side moves alone. |
| `packages/event-schema/src/{registry,payloads}.ts` | New events are **append-only** at the end of the registry object; never edit an existing entry (CLAUDE.md: payloads are versioned, never mutated). One dev per day by announcement; both new-event batches land in Phase 8. |
| `packages/db/migrations/**` | **Numbering protocol below.** |
| `packages/db/src/schema/index.ts` (the barrel) | Append-only exports, alphabetical by module. Conflicts are trivial to resolve because each dev only adds a line. |

### Migration-number collision protocol

drizzle-kit writes `NNNN_slug.sql` + `meta/_journal.json` + `meta/NNNN_snapshot.json`. Two devs generating
concurrently collide on all three. Latest is `0066`.

- **Reserved blocks:** Divyanshu owns `0067–0074`. Prakash owns `0075–0079`.
- Never run `pnpm db:generate` on a branch that is behind `main`. Rebase first.
- If drizzle assigns a number outside your block, rename the file, renumber the `idx` in `_journal.json`,
  rename the snapshot, and re-run `db:migrate` against a fresh DB to confirm. This is exactly what `88cb536`
  had to do by hand; the reserved blocks are how we stop doing it twice.
- The `when` timestamp in `_journal.json` must stay monotonic with `idx`.

---

## 3. Database Changes

Additive except two index swaps. Every migration independently revertible.

**0067 — `pg_trgm` + alias normalization** *(Divyanshu)*
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER TABLE job_domain_alias ADD COLUMN text_norm text;
ALTER TABLE job_domain_alias ADD COLUMN is_searchable boolean NOT NULL DEFAULT false;
ALTER TABLE job_domain
  ADD COLUMN isco_minor_code    text GENERATED ALWAYS AS (left(isco_unit_code,3)) STORED,
  ADD COLUMN isco_submajor_code text GENERATED ALWAYS AS (left(isco_unit_code,2)) STORED;
CREATE INDEX job_domain_alias_text_norm_idx      ON job_domain_alias (text_norm);
CREATE INDEX job_domain_alias_text_norm_trgm_idx ON job_domain_alias USING gin (text_norm gin_trgm_ops);
CREATE INDEX job_domain_isco_minor_idx           ON job_domain (isco_minor_code);
CREATE INDEX job_domain_isco_submajor_idx        ON job_domain (isco_submajor_code);
CREATE INDEX chat_messages_session_created_idx   ON chat_messages (session_id, created_at);
```
`is_searchable` with a constant `DEFAULT` is metadata-only on PG11+ — the same argument `skill.kind` already
makes at `schema.ts:2436-2441`. Generated STORED columns rewrite 4,071 rows (~0.1 s).
Rollback: drop the columns and indexes; leave `pg_trgm` installed.

**0068 — alias uniqueness + HNSW tuning** *(Divyanshu, after the `db:normalize:aliases` runner)*
```sql
CREATE UNIQUE INDEX job_domain_alias_domain_norm_lang_uq
  ON job_domain_alias (job_domain_id, text_norm, lang) NULLS NOT DISTINCT;
DROP INDEX job_domain_alias_embedding_hnsw;
CREATE INDEX job_domain_alias_embedding_hnsw
  ON job_domain_alias USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128) WHERE is_searchable;
CREATE INDEX job_domain_active_selectable_idx
  ON job_domain (job_domain_id) INCLUDE (label_en, isco_unit_code, isco_major_code)
  WHERE selectable AND status = 'active';
```
`NULLS NOT DISTINCT` is PG15+; precedent at `migrations/0037_workable_sue_storm.sql:48`. **Must be preceded
by the dedupe pass** or the unique index fails on `jd_nco_8154_0300`. The HNSW rebuild is free **today**
because the index is empty — doing it before the backfill is the cheapest win in the plan.

**0069 — families + question packs** *(Divyanshu)* — five new tables:

| Table | Key columns | Purpose |
|---|---|---|
| `profiling_family` | `family_id` text PK (`^fam_[a-z0-9_]+$`), `label_en`, `label_hi`, `canonical_role_id`, `industry_id`, `status`, `version`, `replaced_by` | The pack owner. ~200 rows. Gives `canonical_role_id` and `industry_id` (F5) a sane home at 200 rows instead of 4,071. |
| `profiling_family_binding` | `family_id` FK + **exactly one** of `job_domain_id` \| `isco_unit_code` \| `isco_minor_code` \| `isco_submajor_code` \| `isco_major_code` \| `is_universal`; `specificity smallint IN (0,10,20,30,40,50)` | The inheritance table. Most-specific-wins is one `ORDER BY specificity DESC`, not a six-way COALESCE. |
| `question_pack` | PK `(pack_id, version)`, `family_id`, `locale`, `status`, `content_hash` | Versioned container. |
| `question_pack_item` | PK `item_id`; `(pack_id, pack_version)` FK; `question_key` **stable across versions**; `target_kind IN ('rfs','match_skill','attribute','none')`, `target_field`, `target_skill_id`; `answer_type`; `is_mandatory`, `is_core`, `max_asks`; `ask_if`/`skip_if` jsonb; `parent_item_key` | The question. Version-scoped ⇒ immutable by construction. |
| `question_pack_option` | `item_id` FK, `option_key`, `label_text`, `value_*`, `implies_skill_id`, `is_none_of_above` | The chips. |

Integrity worth calling out:
- Six **partial unique indexes** on `profiling_family_binding` (one per target column, plus
  `((true)) WHERE is_universal`) make two families claiming the same target structurally impossible, rather
  than silently papered over by most-specific-wins.
- `CHECK` that exactly one target column is non-null, and that `specificity` matches which one.
- `question_pack_active_uq ON question_pack(family_id, locale) WHERE status='active'` — exactly one active
  version per family. The resolver must never choose.
- `qpi_target_present_chk` — a question must declare where its answer goes, or be explicitly `'none'`.

RLS follows `0066_special_pyro.sql`'s tail verbatim: `ENABLE` + `FORCE ROW LEVEL SECURITY`, then
`REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role`.

**0070 — `unresolved_phrase.scope`** *(Divyanshu — the only non-purely-additive step)*
```sql
ALTER TABLE unresolved_phrase ADD COLUMN scope text NOT NULL DEFAULT 'skill';
ALTER TABLE unresolved_phrase ADD CONSTRAINT unresolved_phrase_scope_chk
  CHECK (scope IN ('skill','occupation'));
CREATE UNIQUE INDEX unresolved_phrase_scope_uq
  ON unresolved_phrase (scope, phrase, domain_id, lang) NULLS NOT DISTINCT;
DROP INDEX unresolved_phrase_uq;
```
**Do not mint a second unresolved table.** `unresolved_phrase` already has the atomic count upsert, the
pseudonymized-only contract, the `open|clustered|resolved` lifecycle, the optional embedding for clustering,
and a live writer. Widen it. This must land *with* the `ON CONFLICT` target change in
`SkillsRepository.recordUnresolved` (`skills.repository.ts:118`, currently `ON CONFLICT (phrase, domain_id,
lang)`), which also gains a `scope` parameter. Sequence: deploy code writing `scope` → apply migration → drop
the old index in a follow-up.
*Caveat:* `skills.dto.ts:36` requires a non-empty `domain_id` on the internal HTTP route. The orchestrator
writes through the repository directly, not that route, so this is not a blocker — but do not widen the DTO
without re-reading its validation.

**0075 — `worker_pack_answer`** *(Prakash)*
```sql
CREATE TABLE worker_pack_answer (
  id uuid PK, worker_id uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  chat_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  pack_id text NOT NULL, pack_version integer NOT NULL, question_key text NOT NULL,
  answer_text text, answer_number double precision, answer_bool boolean, answer_option_keys text[],
  source text NOT NULL DEFAULT 'chat' CHECK (source IN ('chat','chip','form','ops')),
  answered_at timestamptz NOT NULL DEFAULT now(),
  CHECK (exactly one answer_* column is non-null)
);
CREATE UNIQUE INDEX wpa_worker_question_uq ON worker_pack_answer(worker_id, pack_id, question_key);
```
Unique **without** version: a re-interview under v2 replaces the v1 answer for the same `question_key`.
`ON DELETE CASCADE` on `worker_id` means DPDP erasure is covered with **zero code change** —
`WorkersRepository.hardDelete` enumerates no table names, so the cascade *is* the coverage.

**Do not extend `questions` / `worker_answers`** (`schema.ts:852-940`). That table is unversioned, has a
*globally* unique `question_key` (so two packs could not both own `experience_years`), has no options table
(ADR-0005 explicitly defers it), and no conditional logic. Superseded, not extended, and **not dropped**
(CLAUDE.md §10).

**0076 — match-status expansion + `worker_profiles` RLS** *(Prakash)*
Add `matched_lexical` and `matched_worker_confirmed` to `worker_profiles_job_domain_match_status_chk`;
add `match_layer` as a nullable observability column. Adding CHECK values drops nothing and breaks no reader.
Collapsing a worker's explicit chip tap — the highest-quality signal in the system — into `matched_auto`
would be a real loss. Also `ALTER TABLE worker_profiles ENABLE ROW LEVEL SECURITY`.

---

## 4. API Contracts

### New internal routes — `apps/api/src/occupation/` (Divyanshu)

Rides the **existing** `SkillsInternalGuard` / `SKILLS_INTERNAL_TOKEN`. Do not mint a second credential for
the same principal reading the same public reference catalogue — `skills.controller.ts:40-47` already makes
this argument.

```
POST /internal/occupation/resolve
  { text, lang?, k?, allow_vector? }
  → { status, family_id, pack_id, pack_version, catalog_version,
      candidates: [{ job_domain_id, label, score, confidence, layer, family_id }],
      confidence, needs_disambiguation, disambiguation_options[], embed_spent }
GET  /internal/occupation/domain/:id       → metadata + ancestors + family + pack pointer
POST /internal/occupation/question-pack    { family_id | job_domain_id, pack_version? } → resolved pack
POST /internal/occupation/unresolved       → widened recordUnresolved (scope='occupation')
```

The orchestrator calls `OccupationService` **in-process** (same Nest app, no HTTP hop). The routes exist for
the ai-service, ops tooling, and testability.

### `apps/ai-service` — new route (Prakash)

```
POST /profile/parse
ProfileParseInput = {
  schema_version: "oie.v1", worker_ref, language?,
  occupation: { job_domain_id, label, isco_unit_code, match_status, match_score, match_layer,
                pack_id, pack_version } | null,
  answer_map: AnswerRecord[],                                        // THE PRIMARY INPUT
  transcript: { i, role: "worker"|"assistant", text }[],             // indexed EVIDENCE store
  target_fields: [{ field_id, type, enum?, unit?, required }]
}
ProfileParseOutput = {
  fields: Record<FieldId, { value, evidence: { message_index, quote },
                            source: "answer_map"|"transcript",
                            normalization: "verbatim"|"spelling"|"translit"|"unit"|"enum"|"numeric",
                            confidence } | null>,
  unparsed_field_ids: string[], notes: string[]
}
```

**The framing is the enforcement.** The answer map is the *record*; the transcript is the *evidence store*.
The model is never asked "what is this worker's salary" — it is asked "the worker's answer for
`salary_expected` was `"pandrah hazaar mahina"`; return the typed value and quote the span it came from."

Router registration: `profile_parse → ("capable", True)` in `_ROUTE_SHAPES`.

### `packages/ai-contracts` (Phase 0, then frozen)

**Mostly free.** `ConversationStateSchema` already carries six fields documented as the deterministic
engine's vestigial state and "no longer populated": `answered_topics`, `asked_question_ids`, `collected`,
`clarify_count`, `ask_counts`, `unanswered_essentials`. **The orchestrator repopulates all six — that is not
a contract change.**

Additive, all `.default()`ed: `phase`, `occupation`, `answer_map`, `engine_asks`, `pack_id`, `pack_version`,
`catalog_version`. `captured` stays populated as a flattened projection of `answer_map` so anything still
reading it keeps working.

New schemas: `AnswerRecordSchema`, `OccupationPinSchema`, `ProfileParseInput/OutputSchema`,
`QuestionPackSchema`, `PredicateSchema`.

`ProfilingTurnInput/Output` schemas stay exported and marked `@deprecated` even though the route dies —
deleting an exported schema is a package-level breaking change and would fail the parity test for the wrong
reason.

### `apps/api/src/chat/chat.dto.ts` — client-facing, **nothing removed, nothing retyped**

| Field | Change |
|---|---|
| `suggested_followups` | Same field. Now the pack's reviewed `options` instead of model-authored chips. The rule *"options are ANSWERS, never questions"* becomes mechanically checkable because chips are static reviewed data. |
| `asked_question_id` | Same field; values become pack question ids. Safe — `api_models.dart:380-383` states "nothing in the app matches on its value", and it already survived one vocabulary change. **Must still pass the `^[a-z_]+$` ≤40-char filter** (`slugFieldIds`, `chat.service.ts:499-510`) or a bad id discards a completed interview inside the flush transaction. |
| `unanswered_essentials` | Same field; semantics improve (no blocked turns ⇒ always meaningful). Keep the caveat doc. |
| `blocked`, `is_mock`, `extraction_ready`, `session_ended` | Unchanged. `is_mock` becomes permanently `false` — **do not repurpose it.** |
| `progress` *(new, optional)* | `{ answered, total }` — the biggest completion-rate lever for low-literacy users. |
| `question_kind` *(new, default `"ask"`)* | `"ask" \| "disambiguate" \| "clarify" \| "close"` |
| `occupation_label` *(new, default `null`)* | The Hindi/vernacular label once pinned — the "you've been understood" trust moment. |

**Mobile is out of scope** (CLAUDE.md §6 — Rishi/Frontend). The app works unchanged: every new field is
optional and defaulted, and `ChatReply.fromJson` already ignores unknown keys and parses defensively.
**Phase 8 raises one GitHub Issue** covering: (1) progress bar, (2) occupation confirmation pill,
(3) `question_kind == "disambiguate"` → single-select list rather than the horizontal scroller at
`chat_profiling_screen.dart:673-694`, (4) re-verify `session_ended` → `clearChatSession`, and (5) the
outstanding fact that `flutter analyze`/`flutter test` have **never been run** against this branch's Flutter
changes.

---

## 5. Phase Plan

Complexity: S ≤2d, M 3–5d, L 6–10d, XL >10d.

### Phase 0 — Seams & Contract Freeze  *(Owner: Prakash · L · blocks everything)*

**Objective.** Eliminate the four merge-conflict hotspots before parallel work starts.

**Scope.**
- Split `apps/ai-service/app/main.py` (1396 lines, 15 endpoints) into `app/routers/{health,privacy,embeddings,skills,profiling,job_posting,profile,resume,voice}.py` with `APIRouter`s; `main.py` becomes app construction + middleware + `include_router` calls only. **Pure move — no behaviour change.**
- Split `packages/db/src/schema.ts` (3525 lines) into `src/schema/{worker,chat,profile,payer,job,skill,occupation,match,ops}.ts` re-exported by `src/schema/index.ts`, preserving the existing `schema` barrel object shape exactly.
- Split `packages/ai-contracts/src/index.ts` (823 lines) into `src/{conversation,profile,occupation,skills,job-posting,common}.ts` behind `src/index.ts`. Then **freeze**.
- Create `packages/profiling-lexicon` skeleton (package.json, tsconfig, empty `src/{normalize,predicates,values}`, `__fixtures__/`).
- Reserve migration blocks; document the protocol in `docs/engineering-org/development-workflow.md`.
- Fix the ~8 stale "migration 0060" references (`schema.ts:506/2727/2767/3459`, the four `*-job-domains.ts` headers).

**Dependencies.** None. **Merges before any other phase branches.**

**Acceptance criteria.** `pnpm lint typecheck test build` green; `ruff check . && pytest` green; `git diff --stat` shows moves only (no logic lines changed); every existing import path still resolves (barrels preserved).

**Verification.** Byte-compare a `schema` barrel dump before/after. `pytest tests/test_contract_parity.py`. Boot the API and the ai-service; hit `/health` and one endpoint per new router.

**Rollback.** Single revert; nothing depends on it yet.

---

### Phase 1 — Retrieval Foundations  *(Owner: Divyanshu · M · after P0)*

**Objective.** Make the catalogue searchable lexically and make the vector path actually use its index.

**Scope.**
- Migration **0067**; `normalize.ts` in `packages/profiling-lexicon/src/normalize/` — NFKC → lowercase → strip punctuation (keep intra-word `-` `/`) → collapse whitespace → strip a **data-driven** Indian occupational particle list (`wala/wale/wali`, `ka kaam`, `karta hun`, `ki/ka/ke`). The particle list is data, so adding one is not a deploy. Devanagari is **not** transliterated at query time — both scripts exist as separate alias rows.
- `pnpm db:normalize:aliases` runner: backfills `text_norm` and `is_searchable`, dedupes for 0068. Idempotent and resumable (`WHERE text_norm IS NULL`), following `embed-job-domain-aliases.ts`'s progress-or-abort shape.
- `is_searchable = selectable AND status='active' AND NOT (source='isco08' AND has_selectable_nco_children)` — this is the **F4 fix**: it silences the 370 shadowed ISCO unit groups while keeping the 66 unshadowed ones reachable. `selectable` itself is untouched, so no CHECK, no FK, and no written `worker_profiles.job_domain_id` breaks.
- Migration **0068**; rewrite `nearestDomains` as an ANN-first two-stage CTE with `SET LOCAL hnsw.ef_search = 200` and overfetch `clamp(k*8, 50, 400)`; delete the JS `.sort().slice()`.
- Fix the inert "catalog is empty" check in `verify-job-domains.ts`.

**Acceptance criteria.** `db:verify:domains` FAILs on an empty table (regression test for the inert check). `EXPLAIN (ANALYZE)` on the new `nearestDomains` shows an Index Scan on the HNSW index. `is_searchable` true count = 3,885 − 370 shadowed. Normalizer round-trips a 200-case fixture identically in the seeder and the query path.

**Rollback.** Drop 0068 then 0067 indexes/columns; restore the previous `nearestDomains` body (kept in git history, not behind a flag).

#### AS BUILT — five deltas, each forced by a measurement

Phase 1 shipped in migration **`0067_slim_hawkeye`**. Every acceptance criterion is met, but five
things differ from the scope above. Each was driven by running the plan against the live catalogue,
not by preference.

1. **`0068` was folded into `0067`, and is released back to the pool.** The split existed because a
   unique index on `(job_domain_id, text_norm, lang) NULLS NOT DISTINCT` cannot be created while
   `text_norm` is still NULL — verified: `Key (job_domain_id, text_norm, lang)=(jd_isco_8111, null,
   en) is duplicated`. On a FRESH database the failure lands somewhere worse than an upgrade: the
   migrations apply cleanly against an empty table and then `db:seed:domains` aborts mid-chunk, so
   CI and every new developer hit it. Making the index **partial on `is_searchable`** (default
   `false`) removes the ordering dependency entirely — it is empty at creation and cannot fail.

2. **`is_searchable` gained a third determinant: dedupe.** The plan's formula has two clauses
   (selectable+active, not-shadowed). A third is required, because the plan's duplicate count was
   measured on RAW text. Running the real normalizer over all 8,695 aliases finds **70** within-domain
   collisions, not 1 — pairs differing only in punctuation (`"Signaller (railway)"` vs
   `"Signaller, railway"`). Rather than delete rows (they carry stable ids and paid embeddings) or
   NULL the loser's `text_norm` (which would break the runner's `IS NULL` resumability predicate and
   loop forever), `is_searchable` elects exactly one representative per normalized form. All three
   clauses answer the same question — "should retrieval see this row?".

3. **The overfetch is `clamp(k*8, 50, 100)`, not `…, 400`.** Postgres costs an HNSW scan against a
   sequential scan and silently picks the scan past a threshold, returning identical rows more
   slowly. Measured on the partial index: `LIMIT 100` → Index Scan 4.1 ms, `LIMIT 150` → **Seq Scan**
   13.5 ms. An overfetch of 400 is therefore strictly worse than no rewrite at all. Separately,
   `hnsw.ef_search = 800` loses the index at *every* limit including 50 — widening for recall is not
   free. Both thresholds move with corpus size, so **re-measure after Phase 2** rather than trusting
   the constants.

4. **`skeletonKey` is a consonant skeleton, not the vowel substitutions the Phase 0 contract
   described.** Those rules score 2/5 on their own stated examples (they miss
   `welder/waelder/velder`, `mistri/mistry`, `driver/draiver`). The consonant skeleton scores 5/5 for
   a measured 0.9% collision cost. Signature unchanged.

5. **The inert "catalog is empty" check was already fixed on `main`** (it landed via #583), so Phase 1
   only had to prove it: `db:verify:domains` on an empty catalogue exits 1. Six NEW checks were added
   for the `text_norm`/`is_searchable` invariants, and each was proven to fire on injected corruption
   rather than merely to pass.

**Verified:** `is_searchable` → **4,660 aliases across 3,515 domains** — exactly the planned
`3,885 − 370`. `EXPLAIN` shows `Index Scan using job_domain_alias_embedding_hnsw`; the query went
from a 8,695-row Seq Scan + full sort at **44.8 ms** to **10.2 ms**, and from O(n) to O(log n) in
alias count. Fresh-DB rehearsal (migrate → seed → normalize) and rollback → re-apply both clean.

**Not done, deliberately:** the plan's `job_domain_active_selectable_idx` covering index. The outer
join is a PK probe over ≤100 candidate rows and already shows `Index Scan using job_domain_pkey`; a
redundant covering index would cost write amplification on every catalogue seed for no measured gain.
Revisit if the candidate set grows.

---

### Phase 2 — Vernacular Alias Corpus  *(Owner: Divyanshu · XL · after P1)*

**Objective.** Close F1/F2/F3. This is the project's highest-value new asset.

**Scope.** Two generators feeding one reviewable corpus at
`packages/db/data/job-domains/rvm-aliases.jsonl`:
1. **LLM-generated, human-reviewed** — an offline batch script (`scripts/` or a `packages/db` CLI, **never**
   on a request path) prompts a capable model per occupation for vernacular variants: Hindi (Devanagari),
   Hinglish (Latin), regional forms, and common misspellings. Output is JSONL, one line per alias, reviewed
   as a git diff before seeding. This is an authoring aid producing reviewed data, not a model making a
   business decision — CLAUDE.md §3 is satisfied because a human signs the diff.
2. **Mined from `chat_messages`** — extract worker trade utterances from real transcripts, pseudonymize,
   cluster with the existing `packages/db/src/growth-cluster.ts` + `/growth/cluster` pipeline, promote
   clusters to alias candidates. Highest fidelity (literally the words workers use), bounded to trades
   already seen.
- Both write `source='rvm'`; `job_domain_source_chk` and `job_domain_alias_source_chk` already permit it and
  nothing requires `alias.source == domain.source`. **Zero schema change.**
- Also mint `label_hi` on the ~200 families (Phase 4) rather than on 4,071 domains.
- Seed via the existing `db:seed:domains` — `deterministicJobDomainAliasId` makes it idempotent and never
  clobbers a paid-for embedding.
- Re-run `db:normalize:aliases`, then `pnpm db:embed:domains --only-selectable` (~₹5, one time).
- Build a **300-utterance gold set** from real pseudonymized `chat_messages`, labelled by ops **to a family**.

**Sizing.** ~200 families × ~15 vernacular forms ≈ **3,000 aliases** — not 8,695.

**Acceptance criteria.** L0+L1 hit rate **≥ 60%** on the gold set measured **offline with embeddings off**.
`db:verify:domains` clean, including the "no embedding" warning cleared. Zero aliases that fail the
pseudonymizer. Every generated alias has a reviewer in the git blame.

**Rollback.** `rvm` aliases are deletable by `source='rvm'` with no FK impact; the deterministic ids make
re-seeding exact.

---

### Phase 3 — Profiling Lexicon Extraction  *(Owner: Prakash · L · after P0, parallel with P1/P2)*

**Objective.** Make `signals.py`'s 3,197 lines usable from TypeScript without a port-and-pray rewrite.
**This is the single highest-risk piece and it ships isolated, with no behaviour change.**

**Scope.** Extract the *data* into `packages/profiling-lexicon` as JSON; both `signals.py` and a new
`lexicon.ts` load it. Three asset classes:
- **Gazetteers** — `KNOWN_CITIES`/`CITY_ALIASES` (`:748`, already shared with `pseudonymize.py`), states,
  regions, the role/machine/controller/skill keyword tables (`:43-108`) with variants, welding and its
  machining-guard, education/certification canonical values, the curated trade vocabulary.
- **Conversational predicates** the orchestrator needs every turn — `is_dont_know` (`:1936`),
  `is_correction` (`:2133`), `is_hardship` (`:1985`), `is_abusive` (`:2048`),
  `asks_about_job_prospects` (`:2014`), `has_first_person_claim` (`:1420`).
- **Value normalizers + the negation engine** — experience (`:741`), salary + period/year disambiguation
  (`:1010-1097`), city canonicalization (`:755`), relocation, availability and notice-period parsing
  (`:1241-1766`), and `_apply_negation` (`:2098`) / `_negation_vetoed` (`:1456`) so *"abhi kaam nahi mil
  raha"* never becomes `availability: immediate`.

**Two guards, both non-negotiable:**
- Regexes must be written in a **JS/Python-common subset — explicit character classes, never `\d`/`\w`.**
  This repo has already been bitten by exactly this: `skills.dto.ts:10-13` documents that JS `\d` is
  ASCII-only while Python's is Unicode-aware.
- A golden corpus of **≥300 real Hinglish utterances** at `__fixtures__/utterances.jsonl`, asserted
  **identical by both the Vitest and pytest suites** — the same mechanism, and the same reasoning, as
  `test_contract_parity.py`.

**Acceptance criteria.** Both suites green against one fixture file. `pytest` on the existing ai-service
suite unchanged (behaviour-preserving). Deliberately mutating one JSON entry turns **both** suites red.

**Rollback.** Revert; `signals.py` still holds its own data in git history.

---

### Phase 4 — Family & Pack Data Model + Tooling  *(Owner: Divyanshu · L · after P1)*

**Objective.** The schema and the authoring pipeline for occupation-specific questions.

**Scope.**
- Migration **0069** (five tables).
- `packages/db/src/question-pack-corpus.ts` — loader + validator modelled on `validateJobDomainCorpus`,
  including its most important property: **return every problem, never throw on the first**.
- `pnpm db:seed:packs` (idempotent, deterministic ids) and `pnpm db:verify:packs` (live-DB deploy gate,
  reusing `verify-job-domains.ts`'s `Check{name, level, detail, count}` + `exitCode=1` shape).
- Family bindings for all 199 blue-collar ISCO unit groups + the mandatory universal family.
- The `ask_if`/`skip_if` **JSON AST** — never a string, therefore no expression-parser injection surface.
  Closed operators: `all`, `any`, `not`, `answered`, `declined`, `eq`, `neq`, `in`, `gte`, `lte`,
  `occupation_is`, `occupation_under`, `phase_is`, `turn_gte`. Operands: `{"field": id}` →
  `answers[id].valueNormalized`, or `{"const": v}`. Nothing else — **the evaluator can only read the
  normalized answer map**, never raw text, never the transcript, never the clock. ~120 lines, pure,
  validated at boot.

**Validator assertions (the build-time quality gate).** Key shape and per-pack uniqueness; contiguous
`display_order`; every `ask_if`/`skip_if` key exists in the same pack; no `parent_item_key` cycle; follow-up
depth = 1; selects have ≥2 options; `target_skill_id` exists in `skill` with the right `kind`;
`target_field` ∈ the RFS vocabulary; every binding target exists; no two families bind the same target; a
universal pack exists; every `question_key` passes the `^[a-z_]+$` ≤40-char event-payload filter; and —
**every `prompt_text` passes `persona_guard.check_turn`** (one `?`, ≤20 words, no emoji, no exclamation, no
banned vocative). That converts a per-turn runtime cost with a repair retry into a **build-time gate**.

**Acceptance criteria.** `db:verify:packs` FAILs on each seeded-in defect (a cyclic follow-up, a dangling
`ask_if` key, two families on one binding, a missing universal pack, an off-persona prompt). Every ISCO unit
group in majors 5–9 resolves to a family. Fallback chain resolves correctly at all six specificity levels.

---

### Phase 5 — Orchestrator Core  *(Owner: Prakash · XL · after P0+P3)*

**Objective.** The deterministic state machine, built dark and fully unit-tested without a DB or Redis.

**Reference implementation.** `apps/ai-service/app/job_posting_chat/interview_engine.py` is a **shipped,
tested, deterministic question-selecting state machine** with every bound this needs — verified:
`MAX_ASKS_PER_TOPIC = 2` (`:72`), `MAX_ENGINE_ASKS = 16` counted **in asks not turns** (`:84`),
`MAX_INTERVIEW_TURNS` *derived* not guessed (`:94`), `_ask_count` clamping at 0 and flooring at 1 against
malformed persisted state (`:118-131`), `_served_question` as the single source of truth for retry wording
(`:134-144`), `_may_commit`'s three-rule overwrite policy (`:147-164`), `_draft_ready` (`:175-179`),
`_next_topic`'s strict priority with two invariants that hold in every branch (`:182-218`).
**Port the algorithm *and its comments* — those comments encode bugs already paid for.** Do not import
across the language boundary; the file's own header insists on sibling-not-parameterization because the two
conversations have different tone, literacy and vocabulary.

**Scope.**
```
apps/api/src/profiling/
  profiling.module.ts        next-question.ts      # PURE (state, pack) -> Decision. No DI, no I/O.
  orchestrator.service.ts    answer-capture.ts     # PURE (text, askedId, state) -> DetectedAnswers
  conversation-state.ts      predicate.ts          # the safe AST evaluator
  answer-map.ts              pack-registry.service.ts
```
`next-question.ts` and `answer-capture.ts` being pure, DI-free functions is the single most important
structural choice: the whole state machine becomes property-testable ("same answers ⇒ same next question,
always") without a database, a Redis, or a Nest test module.

**Phases:** `IDENTIFY → DISAMBIGUATE → OCCUPATION_SPECIFIC → UNIVERSAL_TAIL → CLOSE`, each with an explicit
exit condition. Priority within a phase mirrors `_next_topic`: unanswered essential under `max_asks` → any
unanswered core at `askCount == 0` → any unanswered optional at `askCount == 0` → drained.

**Momentum vs. loss-aversion.** Occupation-specific questions before universal ones is right (workers answer
about their own trade fluently; salary first has the highest abandon rate). But `current_city` and
`salary_expected` are the strongest matching signals and must survive abandonment. Resolution: `min_turn` /
`max_turn` on the question row hoists `current_city` into the middle of the occupation block. **Data, not a
special case in the engine.**

**Redis envelope v2 + Lua CAS.** Monotonic `rev` as the CAS token, via a preloaded Lua script on the
existing ioredis connection (`Queue.client`). Two layers on double-submit:
- **Layer A — reply cache.** `lastTurn.inboundHash = sha256(sessionId + rev + text)`, 10 s window → return
  the byte-identical previous response, no state change. This is what a mobile client on a flaky 2G
  connection actually needs, not a 409.
- **Layer B — CAS.** Loser reloads, re-checks Layer A against the winner's state, and otherwise re-runs the
  pure decision function against post-winner state. Safe *precisely because the function is pure.* Bounded at
  2 attempts; on exhaustion return the existing `CHAT_UNAVAILABLE_REPLY` and **write nothing**.

**⚠ The single most likely implementation bug in this whole plan:** `ChatTranscriptBuffer.narrow()`
(`chat-transcript.buffer.ts:235-273`) rebuilds the buffer **field by field and drops unknown keys** — verified.
Every new envelope field must be added there or it is silently destroyed on the next load. Put it in the PR
checklist.

**Hard-case handling** (all deterministic, all reusing Phase 3's predicates):

| Input | Behaviour |
|---|---|
| *"nahi pata"* | A **complete answer**: `status:"declined"`, never re-asked, never blocks completion |
| Off-topic | Re-serve with `retry_text` once, then record `unanswered` and advance. **The bound holds even if detection is totally blind** — pin that with a stubbed-detector test, exactly as the payer suite does |
| Correction (*"nahi, 5 saal nahi 7 saal"*) | `_may_commit` returns true for any field; old value → `AnswerRecord.history[]`, `status:"superseded"`. **Load-bearing for the parse call:** the transcript holds both values, so the answer map is what tells the LLM which won |
| Abusive | Fixed de-escalation line, no advance; at 3 → close with `completion_reason:"abuse_cap"`. Message is buffered (audit stays honest) but flagged `excludeFromParse` (model stays clean) |
| Silence / 1-char | Consumes a **turn**, not an **ask**; at 3 → advance |
| Worker asks back (*"job milegi?"*) | Serve the question's `why_text`, then **re-serve the same question**. Never counts as an ask. Bounded at 2 consecutive clarifies |
| Hardship | Acknowledge from the closed appreciation set; no question this turn, no ask counted |

**Acceptance criteria.** ≥95% branch coverage on the two pure functions. Property tests: an answered
question is never re-served; no question exceeds `max_asks` **under a stubbed always-blind detector**;
`MAX_ENGINE_ASKS` is pinned by a test against the arithmetic, not the constant. CAS: two concurrent writers
→ exactly one `rev` increment. `narrow()` round-trips every v2 field.

#### AS BUILT — every scope bullet met, four deltas, three deferrals

Phase 5 shipped in two increments: **#611** (the pure core) and **#614** (the runtime). Every file in
the Scope block exists, every hard case in the table is a test, and all six acceptance criteria are met
— branch coverage is **100%** on all four pure modules, not the 95% the plan asks for. Four things
differ from the scope above, each forced by running the plan against the code rather than by preference.

1. **The engine's bookkeeping is in the Redis envelope, NOT in `ConversationState`.** `servedQuestionKey`,
   `abusiveTurns`, `silentTurns`, `hardshipTurns` and `needsDisambiguation` have no home in the frozen
   contract, and putting them there would freeze one service's state-machine internals into a
   cross-language schema for fields the parse call cannot use and the ai-service must never write. The
   **seven** OIE fields the Phase 0 freeze did specify are all carried and all projected out by
   `toConversationStatePatch`. No contract change was needed.

2. **`narrow()`'s exhaustiveness is a TYPECHECK, not a checklist.** The plan asks for the `narrow()`
   additions to go "in the PR checklist". `PROFILING_ENVELOPE_KEYS satisfies Record<keyof
   ProfilingEnvelope, true>` makes an un-narrowed field fail the BUILD instead, and the round-trip test
   asserts the fixture covers every key so it cannot pass vacuously. Risk #6 is closed mechanically.

3. **`MAX_ENGINE_TURNS` was added, because the ask budget alone does not bound the interview.** A
   hardship turn advances nothing — no ask, no counter, no phase — so an all-hardship conversation ran
   forever. Closed two ways: `MAX_CONSECUTIVE_HARDSHIP = 2` (the same shape as the clarify and silence
   bounds), and a turn backstop DERIVED from those constants rather than guessed, so tightening any one
   of them tightens it automatically. `turn_cap` joins the completion-reason vocabulary.

4. **The registry MAPS three answer types the database allows and the contract does not.** Migration
   0069's `qpi_answer_type_chk` accepts `city | salary | duration`; `ANSWER_TYPES` does not. A reviewer
   authoring a perfectly legal pack row would otherwise fail validation and drop the ENTIRE pack,
   leaving that trade with no interview at all. Mapped to the input affordance each implies; what the
   answer becomes is decided by `target_field`, so nothing is lost. **The narrower fix — aligning the
   two vocabularies — is a joint Phase 0 contract PR and is not taken here.**

**Deferred, deliberately, with owners:**

- **The orchestrator is DARK.** `ChatService.postMessage` still runs the v1 model-driven path,
  untouched; `ProfilingModule` declares no controller and a boot test pins that. Wiring it in is a
  separate change with its own rollback lever — *Prakash, with Phase 7*.
- **`needsDisambiguation` is honoured but never set.** The engine returns a `disambiguate` decision for
  it and the envelope carries it; nothing writes it, because the disambiguation OFFER is built by
  retrieval — *Divyanshu, Phase 7*.
- **`content_hash` is DERIVED at load, not read from the column.** Nothing writes
  `question_pack.content_hash` today, so trusting it would make a required contract field null for
  every pack and drop all of them. A stored hash that disagrees is logged as drift and the database is
  still served — *Divyanshu, Phase 6, when the seeder starts writing it*.

---

### Phase 6 — Pack Authoring at Scale  *(Owner: Divyanshu + content · XL · after P4, parallel with P5/P7)*

**Objective.** Question packs for **all ~200 blue-collar families** (ISCO majors 5–9).

**This is the schedule's long pole and the plan's biggest honest risk.** Hand-authoring 200 packs × ~12
questions ≈ 2,400 reviewed questions is content work measured in weeks, not days. It runs as its own track
so engineering never blocks on it, but **launch does.**

**Scope.** Same generate-then-review pipeline as Phase 2, applied to packs: an offline batch drafts a pack
skeleton per family from the family's occupation `description_en` prose (which is the only task information
NCO gives us); a human edits and signs each pack's git diff; `db:verify:packs` is the mechanical gate.
Prioritise by expected worker volume: welding, tailoring, driving, cooking, electrical, masonry, machining,
security, housekeeping, retail first.

**Acceptance criteria.** 200/200 families have an `active` pack. `db:verify:packs` clean.
`db:audit:domains`-style coverage report: every selectable occupation in majors 5–9 resolves to a
non-universal pack. Each pack has a named reviewer. Golden-transcript fixture per pack (Phase 9).

**Recommendation, stated but not assumed:** cut a **launch gate at ~40 families** covering the top worker
volumes and let the remaining 160 land behind them, since the universal pack keeps every unauthored trade
working. That is a scope decision for the user; the plan as written targets 200.

---

### Phase 7 — Retrieval Service + Final Parsing LLM  *(Owners: Divyanshu (matcher) + Prakash (parse) · L · after P2/P3/P5)*

**The synchronisation point.** Both devs land here against the Phase 0 frozen contract.

**Divyanshu — `apps/api/src/occupation/`:** `OccupationIndexService` (in-process alias index: exact map,
skeleton map, IDF token postings, label map, `catalogVersion` sentinel, ~2–4 MB, background refresh every
900 s), `OccupationRepository` (L0/L1/L2/L3 SQL), `OccupationService` (calibration, thresholds,
disambiguation offers, negative-cache probe), `QuestionPackService` (fallback chain, version pinning).

**Confidence calibration.** Never compare a trigram 0.7 to a cosine 0.7 — different distributions. Map each
layer onto one shared `confidence ∈ [0,1]` via a piecewise-linear table stored as **config**, then apply one
threshold set regardless of layer: `AUTO_FLOOR 0.80` **and** `AUTO_MARGIN 0.12` computed **at family level**;
`DISAMBIGUATE_FLOOR 0.45`; below that, record unresolved and broaden. The existing vector numbers
(`0.55/0.88/0.08`) stay as the raw vector-layer thresholds underneath.

**Disambiguation chips.** Never `label_en` — "Metal Working Machine Tool Setters and Operators" is unusable
as a worker utterance. Use `label_hi`, else the **shortest alias**, because aliases *are* the worker's own
vocabulary by design. Max 4 + a "Kuch aur" escape. The chip→id map is held **server-side** in
`disambiguationOffer` and resolved by that map, not by re-matching text. Collision guard: identical shortest
aliases → qualify from the parent label, else abandon disambiguation for a free-text narrowing question.
**Never show two identical chips** — the chip label becomes the worker's answer of record verbatim
(`chat_profiling_screen.dart:672`).

**Prakash — `POST /profile/parse` + six mechanical "never invent" gates.** Run in the ai-service before the
response leaves, then **again** in Nest before anything is persisted — the same double-wall discipline the
domain match already uses.

1. **Provenance** — `evidence.quote` must be a literal substring of `transcript[message_index].text` after
   whitespace normalization. *The strongest gate: a hallucinated value has no span to point at.*
2. **Role** — the span must come from a `role:"worker"` line. A value sourced from our own question text is
   rejected; this is the exact defect where a controller question's own examples produced five controllers
   from a worker who named one.
3. **Type / enum / range** — `experience_years ∈ [0,60]`; `salary_expected ∈ [1000, 500000]` INR/month;
   `availability` against the existing enum; `current_city` against `KNOWN_CITIES`/`CITY_ALIASES`, kept with
   `city_unrecognized` rather than dropped.
4. **Answer-map agreement** — if the deterministic map holds a non-superseded value, the parsed value must be
   consistent with it. **On disagreement the deterministic value wins, the LLM's is discarded, and
   `profile.parse_disagreement` is emitted (field ids and counts only, never values).** *This is the
   mechanism that makes the LLM structurally incapable of overriding the record. It can only reformat.*
5. **Closed vocabulary** — any `field_id` outside `target_fields` is dropped and counted.
6. **PII re-certification** — every parsed string goes back through `pseudonymize`; blocked or altered ⇒
   rejected.

**Fail-closed: the deterministic map alone must be a usable profile.** Met by normalizing **at capture
time**, not at parse time — `answer-capture.ts` writes `valueNormalized` every turn using Phase 3's
normalizers. When the LLM is down, blocked, or fails every gate:
`AnswerMapProjector(answer_map) → WorkerProfileDraft`, `parse_status = "deterministic_only"`.
**The worker still gets a real profile.** The LLM is an overlay adding coverage regexes cannot reach.

**Precedence, written once, in one function:**
`deterministic answer map > LLM parse (post-gates) > heuristic transcript extractor`.

**The `FIELD_CROSSWALK`** in `packages/profiling-lexicon` publishes RFS→draft mapping as **data**
(`trade→primary_role`, `salary_expected→expected_salary`, `tools_equipment→machines[]+controllers[]` via a
splitter using the existing keyword tables). **Guarded by an exhaustiveness test:** every id in
`PROFILING_REQUIRED_FIELDS ∪ PROFILING_OPTIONAL_FIELDS` must have an entry or CI fails.
*That test is the actual fix for the vocabulary drift; the contract field is just the pipe.*

**Acceptance criteria.** Each gate has a test that a crafted hallucination fails it. Family-level precision
**≥ 0.97** on the 300-utterance gold set. Parse p95 < 6 s. LLM-unavailable → a valid profile from the answer
map alone. `db:verify:domains` + `db:verify:packs` clean.

---

### Phase 8 — Cutover  *(Owners: joint · L · after P5/P6/P7)*

**Objective.** Wire the orchestrator into the live path and delete the LLM interview, atomically.

**Scope.** `ChatService.postMessage` calls `OrchestratorService` instead of `AiService.profilingRespond`.
`finalizeInterview` gains a bulk `worker_pack_answer` insert **as one multi-row INSERT** inside the existing
transaction (twelve separate statements is not acceptable). `ProfileExtractionProcessor` calls
`/profile/parse` with the answer map and the pinned occupation, keeping `isSelectableDomain` as the last
wall. Migrations **0070, 0075, 0076**. New events appended to the registry:
`profile.occupation_identified`, `profile.occupation_unresolved`, `occupation.phrase_unresolved` (sha256 only,
mirroring `SkillsService.recordUnresolved`), `profile.parse_disagreement`.

**Deleted in this PR:** `apps/ai-service/app/profiling/{persona,persona_guard,turn_schema,rfs,opener}.py`;
`prompts.py`'s chat-turn half (`RESUME_SYSTEM_PROMPT` stays); routes `/profiling/respond` and
`/profiling/opening`; `AiService.profilingRespond` / `profilingOpening`; `domain_match.py`'s LLM pick
(`_PICK_SYSTEM`, `_pick_prompt`, `_parse_pick`, the `router.run("domain_match")` call) — **the module and its
DB-truth re-validation discipline survive**, gaining a `pinned_job_domain_id` short-circuit.

**Lift before you delete.** `persona.py`'s *vocabulary* — the "aap" form, the closed `ACKNOWLEDGEMENTS` /
`APPRECIATIONS` sets, the appreciation budget (max 2, never before turn 3), the banned-token list — becomes
static reviewed copy in the packs, enforced by the Phase 4 validator. **Deleting `persona.py` without moving
the voice regresses the product.** Same for `rfs.py`'s `FIELD_GUIDE`/`FIELD_LABEL`.

**Also in this phase:** raise the Frontend GitHub Issue (§4). Update `docs/architecture/overview.md`, write
an ADR superseding the LLM-chat design, and refresh `AI-PROFILING-ARCHITECTURE-STATUS.md`.

**Acceptance criteria.** Full E2E: start session → 12 deterministic turns → completion → parse → profile →
resume. **Zero LLM calls between session start and completion** (assert on the router's call counter).
p95 turn ≤ 400 ms. All existing chat/profile tests green or consciously rewritten. `pnpm lint typecheck test
build`, `ruff check . && pytest`, `RUN_E2E=1` all green.

**Rollback.** `git revert` of this single PR restores the LLM path completely — which is why the deletions
must be *in* this PR and not spread across earlier ones. Migrations 0070/0075/0076 are additive and can stay.
In-flight Redis conversations: the envelope is `v: 2` and the reverted code reads `v: 1` shape via `narrow()`,
which drops unknown keys and yields a clean restart rather than a crash. Bounded by the 24 h TTL.

#### AS BUILT — every scope bullet met, five deltas, three deferrals

The cutover landed as one PR, deletions included, so `git revert` remains the whole rollback story.
Every bullet in the Scope block above exists and is wired. Five things differ from the plan's
wording, each forced by running it against the code rather than by preference.

1. **The migrations are 0071 and 0072, not 0075 and 0076.** drizzle-kit assigns sequentially, and
   0071/0072 are INSIDE Divyanshu's reserved block (0067–0074). The reservation exists so two
   people generating concurrently do not collide on `NNNN_slug.sql` + `_journal.json` +
   snapshot; with one owner on both halves there is no collision to avoid, and renumbering to
   0075 by hand would introduce exactly the journal-editing risk the protocol exists to remove.
   Same tables, same contents, lower numbers.

2. **`worker_pack_answer` gained a `status` column, and the CHECK became a biconditional.** The
   plan specifies `CHECK (exactly one answer_* column is non-null)`, which cannot represent a
   DECLINED answer — and "nahi pata" is the plan's own hardest-won rule: a declination is a
   COMPLETE answer, never a gap. Persisting only valued answers would make "the worker told us
   they do not know" indistinguishable from "we never asked", and only one of those means the
   next interview should ask again. `wpa_answer_shape_chk` now reads
   `(status = 'answered') = (exactly one value column is non-null)`, which preserves the plan's
   intent — no row whose status lies about its contents — while keeping the declination.

3. **The column is `job_domain_match_layer`, not the plan's bare `match_layer`.** It sits beside
   `job_domain_match_status` and `job_domain_match_score` on `worker_profiles`; a lone
   `match_layer` on that table reads as being about something else.

4. **`IdentifyService` is new, and it is the piece that made the cutover work at all.** Phase 5
   shipped an orchestrator with an `occupation` field nothing wrote and a `disambiguate`
   decision that failed closed for want of chips; Phase 7 shipped the ladder and the chip offer
   with no caller. Neither phase's scope named the join, and without it the deterministic
   interview could only ever run the universal pack. It also carries the ONE outbound call the
   interview makes — `/pseudonymize`, on the miss path, at most once per interview, before a
   phrase reaches the growth queue. That is a regex pass, not a model, so the "zero LLM calls
   between session start and completion" gate is untouched.

5. **`domain_match.py`'s ambiguous case is now UNMATCHED rather than a model pick.** The plan
   says to delete the LLM pick and keep the module; what it does not say is what happens where
   the pick used to run. Guessing between two near-identical occupations without asking anyone
   is the exact failure the floor exists to prevent, and this path only runs for a session with
   no answer map. `pinned_job_domain_id` short-circuits before any of it.

**Deferred, deliberately, with owners:**

- **`docs/architecture/overview.md` and `AI-PROFILING-ARCHITECTURE-STATUS.md` do not exist in
  this repository.** `docs/` contains only `sprint-plans/`. The plan's instruction to update
  them cannot be carried out against files that are not here; **ADR-0038** was written instead
  and carries the superseding decision. If those documents live on another branch they need a
  separate pass — *joint, Phase 9*.
- **`MAX_OCCUPATION_REPINS = 1` is implemented as ZERO re-pins.** `IdentifyService` returns
  early on any pinned occupation, which is stricter than risk #12 asks for. Nothing in the
  engine yet distinguishes "I changed trades" from "I mentioned a second machine", and a re-pin
  discards the unanswered questions of the old pack. Widening it needs real utterances to judge
  against — *Divyanshu, Phase 9*.
- **`profiling_persona_guard_enabled` and `profiling_persona_repair_retries` are now inert.**
  The guard they configure is deleted. Left in `config.py` because removing an env key is a
  deploy-surface change that belongs in its own PR — *Prakash's half, next ai-service config
  pass*.

---

### Phase 9 — Calibration, Verification & Hardening  *(Owners: joint · L · after P8)*

**Objective.** Prove the engine on real utterances and close the gates the hard cutover removed a flag for.

**Scope.** Re-calibrate every threshold against production utterances (sweep for family-level precision
≥ 0.97 while maximising coverage — **precision is asymmetric here: a wrong family makes every subsequent
question wrong, which is far worse than one extra clarifying turn**). Reuse the harness shape from
`eval_canonicalization.py` + `canonicalization_gold.py` with a new gold set. Wire the unresolved-phrase growth
loop (`count ≥ N` → ops queue → `rvm` alias → next worker hits L0 free). Add the mid-interview Postgres
checkpoint (`saveConversationState` every 5 asks, **state only, never message text**) so a Redis TTL lapse
costs ≤5 answers instead of the whole interview. Add observability: layer hit rates, per-turn latency, parse
gate rejection counts, disagreement rate.

**Acceptance criteria.** L0+L1 ≥ 45%, L2 ≥ 30%, L3 ≤ 25% on live traffic. Family precision ≥ 0.97.
Per-profile AI cost ≤ ₹15. p95 deterministic turn ≤ 400 ms. Interview completion rate ≥ the LLM baseline.

#### AS BUILT — every scope bullet met; the acceptance criteria split in two

**The constraint that shapes this phase, stated plainly.** Four of the five acceptance criteria are
measurements *on live traffic*, and there is none — this is a pre-launch repository. They cannot be met
here, and reporting them as met would be false. What Phase 9 delivered instead is everything that makes
them measurable on day one, plus every scope bullet, plus the criteria the committed gold set *can*
answer. The remaining four are re-labelled **launch-gated** below, with the exact command that answers
each one.

| Scope bullet | Status |
|---|---|
| Re-calibrate thresholds; reuse the `eval_canonicalization` harness shape | ✅ floor re-derived, gate armed in CI |
| Wire the unresolved-phrase growth loop (`count ≥ N` → ops → `rvm` alias → L0) | ✅ `db:growth:occupation` |
| Mid-interview Postgres checkpoint every 5 asks, state only | ✅ `CHECKPOINT_EVERY_ASKS = 5` |
| Observability: layer hit rates | ✅ pre-existing on `profile.occupation_identified` (Phase 8) |
| Observability: disagreement rate | ✅ pre-existing on `profile.parse_disagreement` (Phase 8) |
| Observability: per-turn latency | ✅ histogram → `profile.interview_completed` |
| Observability: parse gate rejection counts | ✅ `profile.parse_gates_rejected` |

**Five deltas.**

1. **The retrieval gate ran in no workflow.** `db:eval:occupation` exits 1 on failure and was executed by
   nothing — the same way `db:verify:packs` was dead before Phase 8. Armed in the `node` job. The
   calibration act for this metric was **re-deriving its floor**: the script's 60% default against a
   measured **97.0%** cannot catch a regression, since deleting a third of the vernacular alias corpus
   would still pass it. Now `--min-hit-rate 95`. Proven live rather than assumed: exit 1 at 98, exit 0
   at 95. Family precision stays at the script's 97% default — that is the *product* bar; tightening it
   to the measured 98.2% would fail the build for a corpus change that still meets what was asked for.
2. **Latency is a histogram, not per-turn events.** A percentile needs a population, and an event per
   turn is this plan's own risk #9 (~12M rows). Five buckets and a max give the same percentile from one
   event per interview at a cost independent of interview length; 400 ms is a bucket *edge* because it is
   the gate.
3. **The checkpoint is decided by the orchestrator and written by `ChatService`.** Only the orchestrator
   knows both the pre-turn and post-turn ask count, so only it can fire on the *crossing*; a caller
   testing `engineAsks % 5 === 0` re-fires on every subsequent clarify, hardship or silent turn, which on
   a stuck conversation is an UPDATE per turn forever. Carried on `TurnResult` rather than as an envelope
   field, which keeps risk #6 (`narrow()` silently dropping unknown keys) out of the change entirely.
4. **A defect found in the skill growth runner.** `growth-cluster.ts` had no `scope` filter, so after 0072
   it spent real embedding budget on occupation phrases and then skipped every one as a "NULL domain_id"
   warning. Waste and noise rather than contamination (a NULL-domain row cannot reach a proposal), now
   scoped in all four queries.
5. **The occupation growth runner does no clustering and no embedding**, deliberately unlike its skill
   sibling. An unresolved *skill* is usually a near-miss on one we have, so the vector finds the
   neighbour. An unresolved *occupation* has already failed L0, L1, L2 **and** L3 across the whole
   catalogue — embedding it again to hunt a neighbour repeats, at cost, the search that just failed. The
   rank by distinct workers is the signal, and the target renders blank always (SG-5).

**Phase 8 verification gaps closed here.** The cutover's two headline claims had no end-to-end assertion —
unit tests over mocks cannot show that a deterministic interview reached Postgres, because every
collaborator they would need is the thing being stubbed. `phase1-onboarding.e2e.test.ts` now asserts
**exactly one `ai_jobs` row for the whole flow** (the parse — this is "zero LLM calls between session start
and completion", asserted on a count rather than a spy, because a count cannot be satisfied by a second
seam added later), that `worker_pack_answer` rows were written with the biconditional answer shape holding,
and that the latency histogram counted every turn.

**Launch-gated, with the command that answers each.**

| Criterion | Why it cannot be met pre-launch | How to answer it |
|---|---|---|
| L0+L1 ≥ 45%, L2 ≥ 30%, L3 ≤ 25% **on live traffic** | Needs production utterances. The committed gold set measures **97.0% L0+L1**, but it was authored alongside the aliases, so it is an upper bound, not a forecast | Group `profile.occupation_identified` by `match_layer` |
| Interview completion rate ≥ the LLM baseline | Needs both a live cohort and the pre-cutover baseline, which no longer runs | `profile.interview_completed` count ÷ `chat.session_started` count |
| p95 deterministic turn ≤ 400 ms | Needs real load; a local run measures a warm cache and no contention | Sum `turn_latency_ms` buckets across `profile.interview_completed` |
| Per-profile AI cost ≤ ₹15 | Needs real provider spend | `ai_jobs.cost_inr` for `profile_extraction` |
| Family precision ≥ 0.97 | **Met on the gold set: 98.2%**, and armed in CI | `pnpm db:eval:occupation` |

**Two deferrals, logged rather than dropped.**

- **`MAX_OCCUPATION_REPINS` stays at zero re-pins** (stricter than risk #12's 1). Phase 8 deferred this to
  "Phase 9, with real utterances to judge against" — and those are precisely what does not exist.
  Nothing in the engine yet distinguishes "I changed trades" from "I mentioned a second machine", and
  choosing a threshold without evidence is guessing at a behaviour that silently discards a worker's
  pack. *Owner: joint. Blocked on: production utterances.*
- **`docs/architecture/overview.md` and `AI-PROFILING-ARCHITECTURE-STATUS.md` do not exist** in this
  repository (`docs/` holds `sprint-plans/`, `adr/`, `registers/`). ADR-0038 was written in Phase 8
  instead. Creating a whole architecture overview is not this plan's scope. *Owner: joint, separate PR.*

---

### Dependency graph

```
P0 Seams (Prakash) ─── blocks everything ───┐
                                            │
   Divyanshu ─────────────────────┐         │         ┌───────── Prakash
   P1 Retrieval foundations ──────┤         │         │  P3 Profiling lexicon
   P2 Alias corpus (XL) ──────────┤    (parallel)     │  P5 Orchestrator core (XL)
   P4 Family + pack tooling ──────┤         │         │
   P6 Pack authoring (XL) ────────┘         │         └──────────────┐
                     │                                              │
                     └──────────► P7 Retrieval svc + Parse LLM ◄─────┘   ← SYNC POINT
                                            │
                                     P8 Cutover (joint)
                                            │
                                     P9 Calibration (joint)
```

Synchronisation points: **end of P0** (contracts frozen), **start of P7** (both devs against the frozen
contract), **P8** (joint PR). Between P0 and P7 the two tracks share only `packages/profiling-lexicon`, and
even there they own disjoint subdirectories.

---

## 6. Testing Strategy

| Layer | Runner · Location | What it gates |
|---|---|---|
| **Unit** | Vitest, co-located `apps/api/src/{profiling,occupation}/*.test.ts`; pytest `apps/ai-service/tests/` | Pure `next-question` / `answer-capture` / `predicate` (≥95% branch); confidence calibration; the six parse gates. Coverage thresholds already enforced: lines/functions/statements 75, branches 73 |
| **Integration** | Vitest with a live pgvector+redis (the CI `e2e` job's services) | L0–L3 SQL against seeded data; pack fallback across all six specificity levels; CAS under concurrency; the flush transaction with `worker_pack_answer` |
| **Conversation** | **New harness** — see below | The core deliverable |
| **Edge cases** | Vitest + the conversation harness | Every row of the Phase-5 hard-case table; empty/1-char; abuse cap; occupation re-pin; TTL expiry mid-interview; pack version unavailable |
| **Regression** | Existing suites, unchanged | `chat.service.test.ts`, `chat-transcript.buffer.test.ts`, `profile-extraction.processor.test.ts`, `test_pseudonymize.py`, `test_ai_router.py`, `test_spend_cap.py`, `event-schema.test.ts` must stay green through P0–P7 |
| **Performance** | Vitest bench + `EXPLAIN (ANALYZE)` assertions | p95 turn ≤ 400 ms; `nearestDomains` uses the HNSW index; L2 trigram ≤ 15 ms at 30k aliases; the flush transaction stays one round trip per statement class |
| **Migration validation** | `db:verify:domains`, `db:verify:packs`, CI `e2e` job's `db:migrate` | Deploy gates, `exitCode=1` on FAIL. Plus an explicit **rollback rehearsal**: apply 0067–0076, revert, re-apply, on a fresh DB |
| **Resume generation** | Existing `apps/api/src/resume/*.test.ts` + a new golden set | A profile built from the answer map alone (LLM off) still renders every template slot; the masked employer disclosure path is unaffected |
| **Multilingual** | `packages/profiling-lexicon/__fixtures__/utterances.jsonl`, asserted by **both** Vitest and pytest | ≥300 real Hinglish utterances; Devanagari and Latin script; regional spellings; negation cases. One fixture, two languages, both red on drift |

### The conversation test harness

The old CLI harness (`app/cli/onboarding_chat.py`, `tests/cli_harness.py`) was deleted in `fc95d2f`. This is
a rebuild — and a **deterministic orchestrator is finally fully testable without mocking an LLM at all.**

- **Fixture format:** `apps/api/src/profiling/__fixtures__/<family>.transcript.jsonl` — one line per turn,
  `{ worker: "silai ka kaam karta hoon, export line pe" }`, plus expected `{ asked: "...", chips: [...],
  captured: {...}, phase: "..." }`.
- **Replay:** feed worker lines into the pure `nextQuestion` + `answerCapture` pair with an in-memory
  envelope. **No DB, no Redis, no HTTP, no model.** A full 14-turn interview runs in single-digit
  milliseconds, so every one of the 200 packs can have a golden transcript in CI.
- **Assertion style:** assert on the *decision* (`questionId`, `phase`, `reasonCode`, captured field ids),
  never on prose. Prompt copy is asserted separately by the pack validator, so a copy edit does not break
  200 transcripts.
- **The blind-detector suite:** re-run every fixture with all detectors stubbed to return nothing, and assert
  the interview still terminates within `MAX_ENGINE_ASKS` and every must-ask was raised. This is the exact
  safety property `interview_engine.py:71-77` documents, and it is the one that catches an infinite re-ask.
- **Snapshot the final profile** per fixture, so a lexicon change that shifts a normalizer shows up as a diff
  in a real interview outcome rather than only in a unit test.

### CI changes

`ci.yml` needs one addition: the `node` job's `e2e` gate must seed packs
(`db:seed:packs && db:verify:packs`) alongside the existing job-domain seeding. The FastAPI service stays
deliberately unstarted in CI — the API falls back to mocks, and with the parse call being the *only* LLM
call, an unmocked E2E now exercises the entire deterministic path for real.

---

## 7. Verification Strategy

Run at the end of each phase; all must pass before the next merges.

```bash
pnpm lint && pnpm lint:oxlint && pnpm typecheck && pnpm test -- --coverage && pnpm build
cd apps/ai-service && ruff check . && pytest
pnpm db:migrate && pnpm db:verify:domains && pnpm db:verify:packs && pnpm db:audit:domains
RUN_E2E=1 pnpm --filter @badabhai/e2e test
```

**End-to-end manual check (Phase 8 gate).** Boot `pnpm db:up`, `pnpm dev:all`. Start a session as a test
worker; run a **tailor** interview (a trade with no bespoke code path anywhere) through to completion;
confirm: occupation pinned from *"silai ka kaam"*, chips are the pack's reviewed options, the router's
real-call counter reads **0** across every turn, one parse call at the end, `worker_pack_answer` rows written,
`worker_profiles.job_domain_id` populated with `match_layer` set, and the resume renders.
Then repeat with `AI_ENABLE_REAL_CALLS=false` and confirm the deterministic projection still produces a
profile.

**Not verifiable here:** Flutter. No SDK on this machine, and the branch's existing Flutter changes have
never been through `flutter analyze` / `flutter test`. That goes in the Frontend issue, not into this scope.

---

## 8. Rollback Strategy

| Phase | Unit of rollback | In-flight impact |
|---|---|---|
| P0 | Single revert; pure moves | None |
| P1 | Drop 0068 then 0067 indexes/columns; restore the previous `nearestDomains` from git | None — nothing reads the new columns yet |
| P2 | `DELETE FROM job_domain_alias WHERE source='rvm'`; no FK impact; deterministic ids make re-seed exact | None |
| P3 | Revert; `signals.py` retains its data in git history | None |
| P4 | `DROP TABLE` the five new tables | None |
| P5 | Revert; the orchestrator is unreferenced | None |
| P6 | `UPDATE question_pack SET status='deprecated'` for a bad pack; the fallback chain routes to the parent family or universal. **Never crash a live interview over a config change** | Pinned versions are immutable, so in-flight conversations are unaffected |
| P7 | Revert the route; `/profile/extract` is still live at this point | None |
| **P8** | **`git revert` of the single cutover PR** — this is the whole rollback story for the hard cutover, and the reason every deletion lives in this one PR | In-flight Redis envelopes are `v:2`; reverted code's `narrow()` drops unknown keys → clean restart, not a crash. Bounded by the 24 h TTL. Migrations 0070/0075/0076 are additive and stay |
| P9 | Config-only; thresholds live in `packages/config` | None |

**Standing kill switches (all existing, all preserved):** `AI_REAL_CALLS_KILL_SWITCH`,
`AI_ENABLE_REAL_CALLS`, `AI_REAL_CALL_TASKS` allowlist, the four router cost ceilings
(per-call / daily / cumulative / per-user-day), `resume_render`. With the parse call being the only LLM call
left, tripping any of them degrades to the deterministic projection rather than breaking profiling — which
is a strictly better failure mode than today's.

**Data backfill reversibility.** `text_norm` / `is_searchable` are recomputable from the corpus at any time.
Embeddings carry `embedding_model` + `embedded_at` provenance and `--reset-mock-embeddings` already exists —
**do not re-solve this.** `worker_pack_answer` is derived from transcripts and re-derivable.

---

## 9. Architecture Risk Register

| # | Risk | Sev | Mitigation | Phase |
|---|---|---|---|---|
| 1 | **Pack authoring for 200 families doesn't finish** — the only thing between a working engine and launch | **Critical** | Generate-then-review pipeline; volume-ordered priority; the universal pack keeps every unauthored trade working, so a partial corpus still ships. *Recommend a 40-family launch gate.* | P6 |
| 2 | **Vernacular alias overlay never lands** ⇒ L0/L1 ≈ 0%, every turn costs an embed, economics collapse | **Critical** | It is P2, ahead of embeddings; scoped to ~3,000 aliases, not 8,695; two independent generators | P2 |
| 3 | **Hard cutover with no per-trade rollback lever** | **Critical** | All deletions in one revertible PR; P9's precision/latency/cost gates are non-optional; the deterministic projection means an LLM outage never breaks profiling | P8/P9 |
| 4 | **NCO over-granularity** — 44 near-identical titles in unit 7223 make the pick a coin flip | High | Resolve **family first**; margin computed at family level; the exact code settled by the pack's own first question | P7 |
| 5 | **Mixed granularity** — 436 ISCO units compete with 3,449 NCO occupations in one shortlist | High | `is_searchable=false` for the 370 shadowed units; keep the 66 unshadowed. `selectable` untouched | P1 |
| 6 | **`narrow()` silently drops new envelope fields** | High | Explicit PR checklist item + a round-trip test per field | P5 |
| 7 | **Lexicon regex divergence** between JS and Python | High | Common-subset regexes (no `\d`/`\w`); one golden fixture asserted by both suites | P3 |
| 8 | **Redis buffer lost update** (live defect) | High | Lua CAS on `rev`; bounded 2-attempt retry over a pure decision function | P5 |
| 9 | **Write amplification** — 1M conversations × ~12 turns ≈ 24M message rows + 25M event rows | Med | The deterministic engine *shortens* interviews (~12 questions vs a 30-turn cap); consider collapsing per-message events into one versioned `chat.transcript_stored` carrying counts | P9 |
| 10 | **Redis is the only home of in-flight state** | Med | Postgres checkpoint every 5 asks — state only, ≤6 small UPDATEs vs the ~150 rows the buffer design killed. Loss drops from "the whole interview" to "≤5 answers" | P9 |
| 11 | **An embedding on a request path** for an ops-added alias | Med | Queue it. Embeddings never happen synchronously on a turn | P7 |
| 12 | **Occupation contradicted later** (*"ab tempo chalata hun"*) | Med | `MAX_OCCUPATION_REPINS = 1`; keep every answered field, discard only the *unanswered* questions of the old pack. **Never discard an answer** | P5 |
| 13 | **Pack/catalog version changes mid-conversation** | Med | `pack_id` + `pack_version` + `catalog_version` pinned at pin time; ≥30-day version retention; a genuinely-missing version falls back to universal keeping every answer | P4/P5 |
| 14 | **Clock skew inverts message order** — `chat_messages` has no sequence column | Low | The orchestrator clamps `at = max(prevAt + 1ms, now)` when appending. No migration needed | P5 |
| 15 | **`pg_trgm` unavailable on managed Postgres** | Low | In Supabase's default allowlist and in the `pgvector:pg16` image. Verify before P1 merges; fallback is `text_norm` btree + prefix only | P1 |
| 16 | **NCO OCR quality** — 6 occupations missing, artefacts like `"chemic al"` | Low | Load the 6 as `status='provisional', selectable=false` (the value exists with zero rows today); add a verify check that provisional is never selectable | P1 |
| 17 | **Family bindings drift into overlap** | Low | Six partial unique indexes make it structurally impossible | P4 |

### Caching (all version-prefixed — never write invalidation code that enumerates keys)

| What | Where | TTL | Invalidation |
|---|---|---|---|
| Family/pack resolution graph (<200 KB) | in-process, one entry | 60 s soft | poll `max(updated_at)`; rebuild on change. No pub/sub at this size |
| Resolved pack content (pinned version) | in-process LRU, cap 200 | ∞ | **immutability *is* the invalidation** |
| Alias index (exact + skeleton + postings + IDF + labels, 2–4 MB) | in-process per instance | none | `catalogVersion` sentinel poll every 900 s. Multi-instance safe: each builds its own, and `catalogVersion` is pinned per conversation so a mid-flight rebuild is inert |
| L0/L1 resolve result | Redis `occres:v<taxver>:<sha256>` | 6 h | the `v<taxver>` prefix |
| Query embeddings | Redis `oie:embed:<sha256>` | 7 d | model id in the key. **Not on the BullMQ connection** — eviction pressure there would drop jobs |
| Negative cache | the `unresolved_phrase` table | none | ops sets `status='resolved'` |

**Explicitly not cached:** the parse result (one per interview, zero reuse); anything cross-session about a
worker — no cross-session memory exists today, and introducing one is a product + DPDP decision, not an
engineering one.

---

## 10. Reuse Ledger

**Reuse — do not rewrite.** `job_posting_chat/interview_engine.py` (the deterministic state machine to port,
comments included) · `signals.py` (the 3,197-line Hinglish gazetteer + predicates + normalizers) ·
`pseudonymize.py` and `embeddings.py` (the privacy boundary — untouched except the per-message call site) ·
`AIRouter` + the spend ledger + the four cost ceilings + provider fallback · `embed-job-domain-aliases.ts`
(resumable, budget-aware, provenance-stamping — **run it, do not write a second embedder**) ·
`job-domain-corpus.ts`'s loader/validator pattern (including "collect every problem, never throw on the
first") · `verify-job-domains.ts`'s `Check` + `exitCode=1` gate shape · `SkillsInternalGuard` +
`SKILLS_INTERNAL_TOKEN` · `isSelectableDomain` (the last hallucination wall) · `unresolved_phrase` +
`recordUnresolved` + `growth-cluster.ts` (**widen with `scope`, do not mint a parallel table**) ·
`ChatTranscriptBuffer` (extend, do not build a second state store) · `finalizeInterview`'s transaction shape ·
`autoTriggerExtraction`'s three dedupe layers · `EventsService` + `EVENT_REGISTRY` ·
`eval_canonicalization.py` + `canonicalization_gold.py` (the calibration harness — new gold set, same harness) ·
`persona_guard.check_turn` (**promoted** from a per-turn runtime cost with a repair retry to a build-time
pack-validation gate).

**Explicitly avoid duplicating.** A second embedder · a second unresolved queue · a second scoped token ·
a second HTTP seam · a second deterministic engine · a third skill id space. **Do not put pack text in
TypeScript constants** — the entire point is that it is data.

---

## Critical files

- [apps/ai-service/app/job_posting_chat/interview_engine.py](apps/ai-service/app/job_posting_chat/interview_engine.py) — the reference state machine to port ([`:72`](apps/ai-service/app/job_posting_chat/interview_engine.py#L72), [`:84-94`](apps/ai-service/app/job_posting_chat/interview_engine.py#L84-L94), [`:118-131`](apps/ai-service/app/job_posting_chat/interview_engine.py#L118-L131), [`:147-164`](apps/ai-service/app/job_posting_chat/interview_engine.py#L147-L164), [`:182-218`](apps/ai-service/app/job_posting_chat/interview_engine.py#L182-L218))
- [apps/ai-service/app/profiling/signals.py](apps/ai-service/app/profiling/signals.py) — the gazetteer/predicates/normalizers to lift into `packages/profiling-lexicon`
- [apps/api/src/chat/chat.service.ts](apps/api/src/chat/chat.service.ts) — the turn loop being replaced ([`postMessage:162-357`](apps/api/src/chat/chat.service.ts#L162-L357), [`finalizeInterview:377-488`](apps/api/src/chat/chat.service.ts#L377-L488))
- [apps/api/src/chat/chat-transcript.buffer.ts](apps/api/src/chat/chat-transcript.buffer.ts) — [`narrow():235-273`](apps/api/src/chat/chat-transcript.buffer.ts#L235-L273) must learn every new field; [`save():178-200`](apps/api/src/chat/chat-transcript.buffer.ts#L178-L200) becomes the Lua CAS
- [apps/api/src/skills/skills.repository.ts](apps/api/src/skills/skills.repository.ts) — [`nearestDomains:57-83`](apps/api/src/skills/skills.repository.ts#L57-L83) (the HNSW rewrite), [`recordUnresolved:110-125`](apps/api/src/skills/skills.repository.ts#L110-L125) (the `scope` widening)
- [packages/db/src/schema.ts](packages/db/src/schema.ts) — `job_domain`/`job_domain_alias` `:2642-2767`; the superseded `questions`/`worker_answers` `:852-940`; `unresolved_phrase` `:2504-2530`
- [packages/db/src/job-domain-corpus.ts](packages/db/src/job-domain-corpus.ts) — the loader/validator pattern to mirror for `question-pack-corpus.ts`
- [packages/ai-contracts/src/index.ts](packages/ai-contracts/src/index.ts) — `ConversationStateSchema:64-135` (six fields already exist, inert); `ProfileExtractionInputSchema` (where `answer_map` lands)
- [apps/ai-service/app/main.py](apps/ai-service/app/main.py) — 1396 lines to split in Phase 0
