# Skill Discovery & Curation — Architecture Assessment

> Task A of the Skill Discovery workstream. **Assessment only — no production mutation, ₹0 AI spend.**
> Every number below is MEASURED against the live database on **2026-08-26** with a `postgres`
> (BYPASSRLS) role, read-only. Nothing here is estimated unless the line says "estimate".

---

## 0. Executive summary — the three findings that change the design

**1. The population is 9,121, not 4,000+. The 4,071 is the *domain* table.**

| table | rows | note |
|---|---:|---|
| `job_domain` | 4,071 | 3,885 `selectable AND active` |
| `job_domain_alias` | **9,121** | the actual alias population; 3,885 distinct domains covered |
| `job_domain_alias` distinct `text_norm` | **8,762** | the normalized population |
| `job_domain_alias` `is_searchable` | 5,086 | the retrieval surface |

The brief's "4,000+" is the domain count. The discovery input is **9,121 alias rows / 8,762
distinct normalized phrases**. Every downstream figure is computed on that.

**2. Every vector we need already exists and is real. The discovery pass costs ₹0.**

| table | rows | embedded | model | provenance |
|---|---:|---:|---|---|
| `job_domain_alias` | 9,121 | **9,121 (100%)** | `gemini-embedding-001` | real, 2026-08-11, L2-normalized (self-IP = 1.0000) |
| `skill_alias` | 336 | **336 (100%)** | `gemini-embedding-001` | real, 2026-08-21 → 08-24 |

Semantic clustering of the whole alias population **and** existing-canonical similarity
scoring can both be done by reading vectors already paid for. Phase 13's "stop before
spending" only binds later, for phrases that are *not* already an alias row (worker chat
language, and the model-proposed canonical labels themselves).

**3. Most of the population is occupation titles, and that is measurable, not an opinion.**

Head-word frequency over the 3,885 selectable domain labels: `operator` (268), `engineer`
(109), `manager` (98), `maker` (98), `technician` (85)… Over all 13,006 occupation texts
(labels + aliases): `operator` alone heads 1,690. The corpus is agent nouns — names for
*people who hold jobs*. A 1:1 alias→skill mapping would mint thousands of rows that say
nothing an employer can hire on, which is the exact defect
`validateTaxonomyCorpus`'s existing `SKILL_LABEL_IS_DOMAIN_NAME` rule already refuses.

The skill evidence, where it exists, is in the **modifier**, not the head:

```
"Operator, Strip Mill"   head: operator   evidence: {strip, mill}   -> extractable
"Dyer, Leather"          head: dyer       evidence: {leather}       -> extractable
"Magician"               head: magician   evidence: {}              -> nothing to extract
```

---

## 1. Existing taxonomy / skill architecture

Verified from source, not docs. Three id spaces, deliberately disjoint, and conflating any
two of them is the recurring hazard the codebase warns about in four separate docblocks.

| id space | where it lives | size (live) | mutability |
|---|---|---:|---|
| `jd_*` — job domains | `job_domain` table | 4,071 | append-only, immutable ids (SG-5 discipline) |
| `skill_*` — canonical skills | `skill` table + `SKILL_CORPUS` const | 165 rows / 49 seeds | immutable, never reused (ADR-0030 SG-5) |
| `mskill_*` — match skills | `MATCH_SKILLS` const + `skill.kind='match_skill'` | **18, closed** | CEO-ratified 2026-07-30, append-only |
| `dom_*` / bare slugs | `SKILL_DOMAINS` const (11) | TypeScript only | legacy metadata since migration 0076 |

Live `skill` breakdown (measured):

| status | kind | rows |
|---|---|---:|
| active | attribute | 34 |
| active | match_skill | 18 |
| provisional | attribute | 111 |
| deprecated | attribute | 2 |

`job_domain_skill`: **236 active edges**, all `source='llm_bootstrap'`.
`unresolved_phrase`: 47 open (40 `occupation`, 7 `skill`).

### The existing generation pipeline (which this workstream extends, not replaces)

```
db:gen:domain-skills --emit-prompts <dir>     # writes prompts.jsonl, NO model call
   ↓  (operator runs prompts against a capable model, saves raw-responses.jsonl)
db:gen:domain-skills --ingest <dir>
   ↓  validateTaxonomyCorpus     STRUCTURAL gate — ids, edges, alias ownership
   ↓  analyzeTaxonomyQuality     SEMANTIC gate — duplicate/fragmented concepts
   ↓  taxonomyQualityVerdict     PASS -> accepted-*.jsonl | BLOCK -> blocked-*.jsonl + exit 1
   ↓  HUMAN COMMITS the accepted file      <- the review gate today
db:seed:domain-skills --apply                 # skill + skill_alias + job_domain_skill
db:embed:skills --batch <dir>                 # vectors
db:eval:taxonomy                              # retrieval evaluation
db:promote:skills --batch <dir> --apply       # provisional -> active, gated C1..C5
```

**The current review gate is the git diff.** That is the thing this workstream is being
asked to move into the Admin Portal. Nothing about the gates themselves changes.

### Promotion gates (`promote-skills.ts`) — unchanged, not reinterpreted

`C1 GATE_ACCEPTED`, `C2 IS_PROVISIONAL`, `C3 ACTIVE_EDGE`, `C4 FULLY_EMBEDDED`
(incl. reachability under `PRODUCTION_RETRIEVAL_SEMANTICS`), `C5 EVAL_COVERED`.
Freshness is **not** a criterion and **not** waivable — evidence must carry a matching
`corpus_fingerprint`. This workstream adds nothing to and removes nothing from that list.

### Canonicalization flag

`apps/ai-service/app/config.py:384` — `skill_canonicalize_enabled: bool = False`,
`skill_canonicalize_floor: float = 0.75`, `top_k: 5`. **Stays false. Floor stays 0.75.**
This workstream writes no code that reads either.

---

## 2. Existing skill-related tables and constraints (verified from `packages/db/src/schema/`)

- **`skill`** — `skill_id` text PK; `status ∈ active|provisional|deprecated`;
  `kind ∈ match_skill|attribute` (DEFAULT `attribute`); `domain_id` nullable *legacy* since
  0076; `replaced_by` self-FK, only on `deprecated`. `.enableRLS()`.
- **`skill_alias`** — uuid PK (deterministic via `deterministicAliasId`), FK→`skill` CASCADE,
  `text_norm` (L0 key), `is_searchable` (representative election), `embedding vector(768)`,
  `embedding_model` + `embedded_at` provenance. Partial unique
  `(skill_id, text_norm, lang) WHERE is_searchable`, `NULLS NOT DISTINCT` added by hand.
- **`job_domain`** — `jd_*` text PK, `selectable` (CHECK: only level ≥ 4),
  `source ∈ isco08|nco2015|rvm`, generated `isco_minor_code` / `isco_submajor_code`.
- **`job_domain_alias`** — uuid PK, FK→`job_domain` CASCADE, same `text_norm` /
  `is_searchable` / vector / provenance shape. HNSW partial `WHERE is_searchable`.
- **`job_domain_skill`** — composite PK `(job_domain_id, skill_id)`,
  `source ∈ llm_bootstrap|inherited|curated`, `default_requirement`, `relevance`,
  `confidence`, `inherited_from_job_domain_id`.
- **`unresolved_phrase`** — pseudonymized-only, **no `worker_id`**, `scope ∈ skill|occupation`,
  unique `(scope, phrase, domain_id, job_domain_id, lang)` NULLS NOT DISTINCT.
- **`skill_related`** — symmetric adjacency for TIER-2 reach; `mskill_*` only.

Migration state: **0092 is the head and it is applied** (`drizzle.__drizzle_migrations`
`created_at = 1787650702334` == `0092_flawless_glorian.when`). 81 public tables.
**No `*candidate*`, `*discovery*`, `*review*`, or `*curation*` table exists.**

---

## 3. Existing admin architecture

`apps/api/src/admin/` is a mature, well-governed module — this workstream should extend it,
not invent beside it.

- **AuthN**: `AdminAuthGuard` + `admin_sessions`, MFA (`admin-mfa.ts`), OTP.
- **AuthZ**: `admin-capabilities.ts` — a **deny-by-default capability matrix**, pinned
  against ADR-0025 Decision 3 by a drift test. Capabilities include `read_events`,
  `read_entities`, `read_identity`, `reveal_pii`, `read_ai_trace_content`.
  `@RequireAdminRole` sets **exactly one capability per route**, asserted by
  `admin-static-guards.test.ts`.
- **Audit**: `AdminActionsService` — a closed `ADMIN_ACTION_CODES` vocabulary; every governed
  action writes the system-of-record row **and** emits exactly one registry-validated
  `admin.action_performed` **inside one Drizzle transaction**. The spine is **value-free**:
  the code and the opaque target id only, never the value.
- **Idempotency**: terminal actions are no-ops on re-invoke (`changed:false`), so no
  duplicate event.
- **Portal**: `apps/admin-web/src/app/(portal)/` — Next.js App Router, one directory per
  section (`workers`, `jobs`, `events`, `feedback`, `ai-calls`, `system`…), typed client
  contracts in `src/lib/*.ts` with co-located schema tests.

**The closest existing analogue to a review queue is `admin-feedback`** (list → detail →
typed decision). The Skill Discovery queue should follow its shape.

### Existing skill API surface

`apps/api/src/skills/skills.controller.ts` — `POST /internal/skills/nearest-aliases`,
`nearest-domains`, `record-unresolved`. Behind `SkillsInternalGuard` (scoped
`SKILLS_INTERNAL_TOKEN`, fail-closed), **service-to-service only, no user principal**.
There is **no admin-facing skill route today**. This workstream adds the first.

---

## 4. Existing embedding pipeline

```
packages/db  db:embed:skills / db:embed:domains
      │  (owner DB connection — the ai-service is DB-free by design)
      ▼
apps/ai-service  POST /embeddings/skill-alias
      │  pseudonymize (fail-closed) → gemini-embedding-001 @ outputDimensionality 768
      │  L2-normalize client-side → cost_tracker → per-request INR ceiling (TD64)
      ▼
skill_alias.embedding / job_domain_alias.embedding  + embedding_model + embedded_at
```

- Mock by default (₹0). Real path gated by `AI_ENABLE_REAL_CALLS` **and** the
  `skill_embedding` task allowlist **and** a per-request INR ceiling.
- Batch = 100 texts/request (a **quota** fix for the 1000/day free-tier limit, not latency).
- Price, from `apps/ai-service/app/ai/model_config.py:192`:
  `gemini-embedding-001 = ₹0.0125 per 1k input tokens, no output tokens`.
- Resumable: only `embedding IS NULL` rows are fetched.

**Consequence for this workstream:** re-using the 9,121 + 336 stored vectors is not a
shortcut, it is the correct design — they are real, single-model, L2-normalized, and
provenance-stamped.

---

## 5. Existing review / approval / provenance patterns

Five patterns already exist and all five are reused rather than reinvented:

| pattern | module | reused for |
|---|---|---|
| batch dir + accepted/blocked + human commit | `generate-domain-skills.ts` | the discovery run artifact |
| corpus fingerprint (equality, never a timestamp) | `corpus-fingerprint.ts` | run input fingerprint + stale-evaluation guard |
| evidence provenance header | `evidence-provenance.ts` | every committed report |
| ops guard (classify the **target**, not `NODE_ENV`) | `ops-guard.ts` | every runner |
| admin action code + value-free spine event, one txn | `admin-actions.service.ts` | the reviewer decision audit |
| stable problem codes | `taxonomy-corpus.ts` | candidate validation codes |
| lexical equivalence evidence | `taxonomy-lexical.ts` | dedup + existing-skill matching |

---

## 6. Proposed data model

### 6.1 Naming — the project's conventions, not the brief's

The brief proposes `PENDING / APPROVED_CREATE / APPROVED_MAP / APPROVED_MERGE / REJECTED /
NEEDS_REVIEW`. The repository's convention for a lifecycle column is **lowercase snake with
a CHECK constraint** (`skill.status`, `job_domain.status`, `unresolved_phrase.status`,
`job_domain_skill.status`). Proposal — same concepts, house spelling:

```
pending  →  needs_review  →  approved_create | approved_map | approved_merge | rejected | deferred
```

`deferred` is an addition. Without it an undecidable candidate either sits in
`needs_review` forever (indistinguishable from "nobody opened it") or takes a `rejected` it
does not deserve. The queue metrics must be able to tell those apart.

`approved_*` and `rejected` are **terminal**. Re-deciding is a *new candidate in a new run* —
which is what the run fingerprint makes visible. Re-opening in place would silently re-scope
a human decision to a corpus that human never saw.

### 6.2 Tables (additive, three of them)

```
skill_discovery_run   1 ──< skill_candidate   1 ──< skill_candidate_source
                                    │
                                    └──< skill_candidate_match   (competing canonical matches + scores)
```

**`skill_discovery_run`** — reproducibility.
`run_id` (text PK, `sdr_<iso>-<slug>`), `status ∈ running|completed|failed`,
`input_fingerprint` (the `corpus-fingerprint.ts` digest **plus** the head-lexicon digest),
`config_json`, `source_count`, `normalized_count`, `candidate_count`, `cluster_count`,
`error_count`, `model`, `prompt_version`, `embedding_model`, `started_at`, `completed_at`.

**`skill_candidate`** — one row per *cluster*, not per alias. That is the whole workload
reduction; see §11.
`candidate_id` (uuid PK, deterministic in `(run_id, cluster_key)`), `run_id` FK,
`cluster_key`, `normalized_phrase`, `proposed_skill_name`, `proposed_description`,
`phrase_class`, `classifier_rule`, `occupation_heads[]`, `evidence_tokens[]`,
`source_alias_count`, `source_domain_count`, `trade_family`, `proposed_action`,
`confidence_band ∈ high|medium|low`, `confidence`, `status`, `reviewer_admin_id` FK
→`admin_users`, `reviewed_at`, `review_reason`, `resulting_skill_id` FK→`skill`,
`embedding_status`, `model`, `prompt_version`, `corpus_fingerprint`,
`provenance_digest`, `created_at`, `updated_at`.

**`skill_candidate_source`** — the traceability the brief's Phase 8 auditor needs
("*which job-domain aliases caused this skill to be proposed?*").
PK `(candidate_id, source_type, source_id)`; `source_type ∈ job_domain_alias |
job_domain_label | unresolved_phrase | worker_phrase | job_text | skill_alias`;
`original_text`, `normalized_text`, `job_domain_id` (nullable FK).

**`skill_candidate_match`** — the competing existing-canonical matches, plural by design.
PK `(candidate_id, skill_id)`; `relation`, `score`, `strength ∈ strong|weak`, `rank`,
`evidence_detail`. **Never collapsed to a winner** — §5 of the brief requires the reviewer
see the competition, and the false-match examples (`ducting_installation → plumber`) are
exactly what a single "best match" field would hide.

### 6.3 Constraints that carry the safety properties

- `CHECK` on every enum column (house style — `skill_status_chk` is the model).
- `CHECK approved_map/approved_merge ⇒ resulting_skill_id IS NOT NULL`.
- `CHECK approved_create ⇒ proposed_skill_name IS NOT NULL`.
- `CHECK status IN (human-decided set) ⇒ reviewer_admin_id IS NOT NULL AND reviewed_at IS NOT NULL`.
- `CHECK status IN ('pending','needs_review') ⇒ reviewer_admin_id IS NULL` — a machine
  status carrying a reviewer claims a decision nobody made.
- **`CHECK resulting_skill_id NOT LIKE 'mskill\_%'`** — the Phase-12 wall, in the database.
- FKs to `skill` are `ON DELETE NO ACTION` (SG-5: a skill is deprecated, never deleted).
- All four tables `.enableRLS()`; FORCE + REVOKE carried by the migration, matching 0076/0066.

### 6.4 What is deliberately NOT in the model

- **No `mskill_*` column of any kind.** A candidate cannot reference, propose, or mint one.
- **No `job_domain_skill` writer.** The taxonomy edge is a separate, later decision.
- **No auto-promotion field.** `skill.status` still moves only through `db:promote:skills`.

---

## 7. Proposed end-to-end workflow

```
 SOURCES (measured availability, 2026-08-26)
 ├─ job_domain_alias        9,121 rows / 8,762 distinct text_norm   [100% embedded, ₹0]
 ├─ job_domain.label_en     3,885 selectable+active                 [₹0]
 ├─ unresolved_phrase          47 open (40 occupation, 7 skill)     [real worker language]
 ├─ chat_messages inbound     232 worker messages with body_text    [needs pseudonymization]
 ├─ jobs.description / .requirements     0 of 19 populated          [SOURCE IS EMPTY TODAY]
 └─ worker_profiles.skills               0 of 22 populated          [SOURCE IS EMPTY TODAY]
        │
        ▼  ── DETERMINISTIC, ₹0, no model ──────────────────────────────────
 1. normalizeOccupationText            (the SAME function text_norm stores)
 2. classifyPhrase                     REJECTED_NON_SKILL | OCCUPATION_ONLY |
                                       OCCUPATION_WITH_SKILL_EVIDENCE | ACTIVITY_PHRASE | AMBIGUOUS
 3. matchExistingSkills                L0 exact text_norm -> L1 skeleton -> lexical equivalence
 4. clusterPhrases                     union-find; STRONG evidence only, weak pairs escalated
        │
        ▼  ── SEMANTIC, ₹0 (stored vectors) ────────────────────────────────
 5. vector rescoring of surviving clusters against skill_alias.embedding
        │
        ▼  ── AI, COSTED AND GATED ─────────────────────────────────────────
 6. canonical-label + description proposal, per CLUSTER (never per alias)
    prompt_version + model recorded as provenance; the model NEVER supplies an id
        │
        ▼  ── HUMAN ──────────────────────────────────────────────────────
 7. Admin Portal review queue:  MAP | CREATE | MERGE | REJECT (+ reason, mandatory)
        │
        ▼  ── EXISTING PIPELINE, UNCHANGED ────────────────────────────────
 8. approved_create -> data/taxonomy/*.jsonl -> validateTaxonomyCorpus
                    -> taxonomyQualityVerdict -> human commit -> db:seed:domain-skills
 9. db:embed:skills  ->  db:eval:taxonomy  ->  db:promote:skills (C1..C5)
10. MATCH_SKILLS mapping: SEPARATE owner decision. Never automatic.
```

Step 8 is the load-bearing one: **the discovery layer's output re-enters the pipeline that
already exists, at the point where a human commit already happens.** No gate is bypassed;
the Admin Portal replaces the *reviewing*, not the *gating*.

---

## 8. Estimated engineering tasks

| # | task | owner (CLAUDE.md §5) | size | depends on |
|---|---|---|---|---|
| A | architecture assessment | backend | **done** | — |
| B | migration 0093 — run/candidate/source/match + RLS | backend | M | A |
| C | dry-run discovery pipeline (`db:discover:skills`) | backend | L | A |
| D | existing-canonical matching + clustering + vector rescoring | backend | M | C |
| E | admin APIs (list / detail / decide / metrics) | backend | M | B |
| F | **admin review UI** | **frontend — see §9 risk R1** | L | E |
| G | approval → corpus-export + audit workflow | backend | M | B, E |
| H | tests + guardrails | backend | M | B–E, G |
| I | 9,121-alias DRY RUN + evidence report | backend | S | C, D, H |

**9 tasks; 8 are backend-owned.** Task F crosses the ownership boundary.

Already written during this assessment (Task C/D foundations, pure, no I/O, not yet wired):
`skill-discovery-heads.ts`, `skill-discovery-classify.ts`, `skill-discovery-match.ts`,
`skill-discovery-candidate.ts`.

---

## 9. Risks

**R1 — OWNERSHIP (needs your ruling).** CLAUDE.md §5/§6 assigns `apps/admin-web` to the
Frontend Platform (Rishi) and says *"If Backend work requires Frontend changes: complete
only Backend work. Raise a GitHub Issue for Frontend."* Task F is a frontend surface. Default
plan: **deliver A–E and G–I, and raise a fully-specified GitHub Issue for F.** Say the word
and I will build F too — that is your call to make, not mine.

**R2 — False semantic matches (the brief's Phase 4).** Already demonstrated in this repo:
`ducting_installation → plumber`, `visual_defect_identification → quality_inspector`,
`split_unit_installation → fitter`. **Mitigation:** similarity is stored on
`skill_candidate_match` as *evidence with a strength*, never as an authorization; the schema
has no threshold-driven state transition at all; `strength='weak'` can never auto-populate
`proposed_action`; the reviewer sees the full competing set.

**R3 — Occupation titles becoming skills.** The dominant failure mode given a 9,121-row
agent-noun corpus. **Mitigation:** the occupation-head lexicon (§0 finding 3), derived from
the catalogue rather than invented, plus the existing `SKILL_LABEL_IS_DOMAIN_NAME` gate on
the way back in.

**R4 — Head-lexicon drift silently changing the candidate set.** Two runs disagreeing about
whether `fitter` is an occupation head produce different candidates from identical inputs.
**Mitigation:** `headLexiconFingerprint` is folded into `skill_discovery_run.input_fingerprint`,
so a drifted run cannot be mistaken for a re-run.

**R5 — Terminal decisions re-scoped by a later corpus.** **Mitigation:** terminal statuses;
re-decision requires a new run; `corpus_fingerprint` stored per candidate.

**R6 — Two empty sources reported as if they were populated.** `jobs.description` (0/19) and
`worker_profiles.skills` (0/22) are measurably empty. **Mitigation:** the report states the
zero rather than omitting the source; the pipeline keeps the source wired so it starts
contributing the day the data exists.

**R7 — Reviewer fatigue.** 8,762 distinct phrases is not a reviewable queue. **Mitigation:**
§11 — one candidate per *cluster*, prioritized; the exact reduction is measured in Task I,
not promised here.

**R8 — RLS invisibility.** Every taxonomy table is FORCE RLS with zero policies; a role
without BYPASSRLS reads them empty and "0 candidates" would mean "not permitted to look".
**Mitigation:** the `evidence-provenance.ts` header records `role` + `bypass_rls` on every
artifact, as it already does for the other audits.

**R9 — Migration authored but not applied.** This repo applies migrations by hand, and owed
journal rows are routine. **Mitigation:** Task B ships the migration *and* leaves it
unapplied; applying it is on the authorization list in §"Decisions needed".

---

## 10. Files / modules likely to change

**New — `packages/db/src/`** (backend-owned):
`skill-discovery-heads.ts` ✔, `skill-discovery-classify.ts` ✔, `skill-discovery-match.ts` ✔,
`skill-discovery-candidate.ts` ✔, `skill-discovery-run.ts`, `skill-discovery-plan.ts`,
`skill-discovery-cost.ts`, `discover-skills.ts` (CLI), plus co-located `*.test.ts`.

**New — schema/migration:** `packages/db/src/schema/skill-discovery.ts`,
`packages/db/migrations/0093_*.sql` + snapshot + journal entry.

**New — `apps/api/src/admin/`:** `admin-skill-discovery.{controller,service,repository,dto}.ts`
+ `.authz.test.ts`, following `admin-feedback.*` exactly.

**Modified (additive only):**
`packages/db/src/schema/index.ts` (export new tables) ·
`packages/db/package.json` (add `db:discover:skills`) ·
`apps/api/src/admin/admin-capabilities.ts` (add `review_skill_candidates`) ·
`apps/api/src/admin/admin-actions.service.ts` (`ADMIN_ACTION_CODES` +
`skill_candidate_decided`) · `apps/api/src/admin/admin.module.ts` ·
`docs/registers/decisions-log.md`.

**Modified — frontend (Task F, pending R1):**
`apps/admin-web/src/app/(portal)/skills/` (new) · `apps/admin-web/src/lib/skill-discovery.ts`.

**Explicitly NOT touched:** `packages/taxonomy/src/match-skills.ts`,
`packages/taxonomy/src/skill-corpus.ts`, `packages/taxonomy/src/promotable-skills.ts`,
`packages/match-engine/*`, `apps/ai-service/app/config.py`, `promote-skills.ts`,
`taxonomy-quality-gate.ts`, `taxonomy-corpus.ts` validator rules.

---

## Decisions needed from you (nothing is blocked on them today)

1. **R1 — Task F ownership.** Backend-only + GitHub Issue for the UI (default), or build the UI too?
2. **Apply migration 0093** when Task B lands (production DDL — needs your authorization).
3. **AI spend for step 6** (canonical-label proposal). Cost will be reported in Task I against
   the measured cluster count, before any call. Steps 1–5 remain ₹0 regardless.
4. **`skill_candidate` table vs. file-only staging.** The table is the plan above; file-only
   would need no migration but no queryable review either. Recommending the table.

---

*Provenance: measured 2026-08-26 against `SUPABASE (remote)` as `postgres` (bypass_rls=true),
read-only. Sources: `packages/db/src/schema/*.ts`, `packages/db/src/*.ts`,
`apps/api/src/{admin,skills}/*.ts`, `apps/ai-service/app/{config.py,ai/*.py}`,
`packages/taxonomy/src/*.ts`, live `information_schema` + `drizzle.__drizzle_migrations`.*
