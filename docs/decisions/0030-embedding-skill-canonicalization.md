# ADR-0030: Embedding-based skill canonicalization — resolve free-text skill phrases to an immutable, standard, India-named `skill_id` via vector similarity (amends ADR-0028 Open Question #1)

- **Status:** **Accepted** (ratified by owner directive to proceed with TAX-1, 2026-07-14 — after the `security-engineer` read returned BLOCK on three false schema premises + the invariant-#4 phantom-table fence, all **corrected before ratification**). Architecture gate — this ADR draws the seam and the phased rollout; it produces **no code, schema, migration, extension, import, or embedding call**. Implementation is handed to the engineer agents per phase (TAX-1…TAX-9), each its own PR behind its own enter-gate. **Downstream phases past TAX-1 still hold at their own §7 gates** (b–e: real embedding calls/spend, licensing, RVM wedge, provider data-retention).
- **Date:** 2026-07-14
- **Phase:** cross-cutting foundation. **NOT a §2 invariant relaxation** — it adds a *canonicalization* layer over a **closed, versioned, immutable `skill_id` space**; it introduces **no** skills signal into ranking (invariant #4 holds — see §Invariant-#4 boundary).
- **Author:** system-architect. **Ratification is an owner (human) gate** — the Status flips Proposed→Accepted only by the owner, after the `bb-architecture-review` pass and a `security-engineer` read of the PII/embedding boundary.
- **Amends:** **[ADR-0028](0028-international-occupation-taxonomy-adoption.md) — Open Question #1** ("Skill-taxonomy granularity … NCO-2015/ISCO-08 classify *occupations*, not skills … Decide whether to key skills to a separate standard (e.g. an ESCO-style skills pillar) … **must be resolved before Phase 2 canonicalizes skills**"). This ADR resolves that OQ; ADR-0028's OQ#1 now points here.
- **Builds on / reconciles (verified against the repo, 2026-07-14):**
  - **ADR-0028** — adopts NCO-2015 / ISCO-08 as the shared **occupation** spine behind the `map_rich_to_legacy` mapper seam; explicitly deferred **skills** to OQ#1. This ADR is the resolution: occupations stay ADR-0028's job; **skills get their own standard-backed, embedding-canonicalized id space**, plugged into the *same* mapper seam.
  - **ADR-0008** (`0008-litellm-to-direct-providers.md`) — LLMs assist (profile / canonicalize / explain), **never rank or decide**. Here the LLM emits skill *phrases*; the **vector layer** (deterministic, provider-embedded but locally-compared) assigns the `skill_id`. The LLM never invents a `skill_id` (SG-3).
  - **ADR-0011 / ADR-0015** (`0011-reach-feed-serving.md`, `0015-reach-feed-on-real-jobs.md`) — the deterministic RANK core. It keys the **Role** factor on `canonical_role_id`; it has **no skills factor and no embeddings today**. This ADR adds **neither** to ranking (see §Invariant-#4 boundary).
  - **`packages/taxonomy/src/index.ts`** — currently 9 placeholder `skill_*` ids + 5 `mach_*` ids, "existing ids must remain stable." This package becomes the versioned home of the crosswalk from those legacy ids into the new standard skill vocabulary; **legacy ids stay valid** (additive).
  - **`apps/ai-service/app/profiling/signals.py`** (`_SKILLS` / `_MACHINES` / `_CONTROLLERS` gazetteer) + **`profile_extractor.py`** (`map_rich_to_legacy`) — the seam. `map_rich_to_legacy` canonicalizes model-emitted rich labels → closed-set ids, re-validated so no free text enters a matchable field. **The vector resolver becomes the skills arm of exactly this seam.**
  - **`apps/ai-service/app/pseudonymize.py`** — fail-closed pseudonymization runs before every LLM/provider call. Skill *phrases* carry no identity PII, but they pass through the pseudonymizer anyway (SG-1/SG-2 — see below).
  - **`packages/db/src/schema.ts`** — **36 tables today. `pgvector` is ALREADY enabled** (`CREATE EXTENSION IF NOT EXISTS vector;` in migration `0001_same_xavin.sql`) and a **live `vector(768)` column already exists: `worker_profiles.embedding`** (schema.ts ~L364, with an HNSW cosine index `worker_profiles_embedding_hnsw`, documented "Managed Vertex embedding, text-multilingual-embedding-002, 768-dim, for semantic similarity", nullable/unused until plans G3/G5). So TAX-1 does **not** enable a new extension and does **not** introduce vectors to the codebase — it adds **3 additive tables** (36→39) using the already-enabled extension and the established **768** dimension. **`worker_profiles.embedding` is a ranking-adjacent artifact and is explicitly out of the RANK path today — see §Invariant-#4 boundary.**
  - CLAUDE.md §2 invariants #1 (event-first), #2 (no raw PII), #3 (pseudonymize fail-closed), #4 (LLMs never rank/decide), #5 (real calls gated/off-by-default), #7 (typed contracts), #8 (backward-compatible / versioned); §3 locked stack; §7 escalation.

---

## Context

ADR-0028 gave workers and jobs a shared **occupation** id space (NCO-2015/ISCO-08) but explicitly stopped at **skills**: occupation-classification standards code *jobs*, not *what a person can do*. Today "what a worker can do" is a **local, ad-hoc CNC/VMC gazetteer** — `signals.py` `_SKILLS`/`_MACHINES`/`_CONTROLLERS`, mirrored as 9 placeholder `skill_*` ids in `packages/taxonomy`. Three structural problems fall out:

1. **Skills have no standard, so adjacent supply/demand can't meet on skill.** A worker who says "setting", "drawing padhna", "tool offset", "kharad" and a job that asks for "machine setter", "GD&T reading", "turning" describe overlapping capability, but there is no shared id they resolve to — so even after ADR-0028 unifies *occupations*, **skill-level matching is impossible** because there is no skill id space at all.
2. **Free text is unbounded; a fixed keyword gazetteer is brittle.** Blue/grey-collar skill language is code-mixed, misspelled, and regional ("chhilai", "chilai", "chhillai"; "ghisai"; "welding"/"welder"/"wELDING"). A keyword list either misses variants (false negatives → lost matches) or gets hand-patched forever. It cannot generalize to phrasings it has never seen.
3. **The LLM must not be trusted to mint ids.** The model is good at *reading* a messy phrase; it is not a source of truth for a canonical id (invariant #4 / SG-3). We need a deterministic assignment layer between "model-emitted phrase" and "id written to a matchable field."

The clean fix is **embedding-based canonicalization**: embed the worker/job skill *phrase*, find its nearest neighbour among **embedded aliases** of a **closed, standard-backed skill vocabulary**, and — only above a confidence floor — assign that vocabulary entry's immutable `skill_id`. Below the floor, the phrase is **never force-matched**; it lands in an `unresolved_phrase` queue for clustering + human promotion. This generalizes across spelling/dialect variants (vector similarity, not exact keyword), keeps the id space **closed and immutable** (matchable fields only ever get a validated `skill_id`), and keeps the **LLM assist-only** (the vector layer, not the model, assigns the id).

The owner (2026-07-14) directed the resolution of ADR-0028 OQ#1: **adopt ESCO (skills skeleton) + O\*NET (tool/machine depth) + NCO-2015 (India occupation names) + RVM (the industrial-manufacturing wedge), and canonicalize skill phrases to an immutable `skill_id` by vector similarity over aliases, with a confidence floor and an unresolved queue — never forcing a match.** This spans a new datastore capability (pgvector), a real embedding-provider call, external-standard licensing, and a hand-curated wedge — each a **§7 gate** — so it is an **ADR of record with a phased, gated rollout**, not an inline build.

---

## Decision

**Adopt a standard-backed, embedding-canonicalized SKILL id space — resolving ADR-0028 OQ#1 — behind the existing `map_rich_to_legacy` mapper seam, additively and versioned. Occupation ids from ADR-0028 are unchanged.**

### (a) Sources — four pillars, one closed vocabulary

The canonical **skill vocabulary** is authored (versioned, in `@badabhai/taxonomy` + the `skill` table) from four sources, each carrying its provenance in a `source` field:

| Source | Role in the vocabulary | Licensing (verify + record — §7) |
|---|---|---|
| **ESCO** | the **skills skeleton** — the standard skill/competence pillar occupations lack (ESCO explicitly separates skills from occupations). | ESCO is published under a permissive licence (CC-BY-family). **Confirm exact redistribution terms + attribution before import.** |
| **O\*NET** | **tool/machine + technology-skill depth** (specific equipment, controllers, techniques). | O\*NET is US-Government public-domain (with an attribution request). **Verify + record.** |
| **NCO-2015** | **India occupation names** (already ADR-0028's spine) — anchors skill entries to India-recognized occupations. | Government of India classification; ADR-0028 already governs its use. |
| **RVM wedge** | the **industrial-manufacturing wedge** — the shop-floor Hinglish/regional skills the standards miss ("kharad" = turning, "chhilai" = milling/shaving, "ghisai", "setting"). **Hand-seeded, human-ratified** (TAX-5). | First-party; the wedge's correctness is an **owner/human gate**, not an external licence. |

The vocabulary is a **closed set**: a matchable field only ever receives a `skill_id` that exists in the `skill` table. New entries are added deliberately (import or human promotion), never minted at request time.

### (b) Canonicalize by vector similarity over **aliases**, with a floor and an unresolved queue

- Each `skill` has many `skill_alias` rows (label variants, spellings, Hinglish/regional forms, ESCO/O\*NET alt-labels). **We embed the ALIASES, not the canonical label** — because a worker says "chhilai", not "milling (metalworking)". The alias is the bridge from real language to the canonical id.
- **Resolve** = pseudonymize the phrase → embed it → **domain-scoped** nearest-neighbour search (HNSW, cosine) over `skill_alias.embedding` within the phrase's domain → if the top neighbour's similarity ≥ a **confidence floor (~0.80–0.85, tuned per TAX-9 eval)**, assign that alias's `skill_id`; **else assign nothing** and record the phrase in `unresolved_phrase`.
- **Never force a match.** Below the floor is a first-class outcome, not an error: the phrase is stored (pseudonymized), counted, and later **clustered** (TAX-7) so ops/product can promote a recurring cluster to a **provisional** skill (`status='provisional'`) with human review. This is the growth loop — the vocabulary widens from real demand, gated by humans, never by the model.

### (c) Immutable ids; versioned; retag — never renamed, never reused

- `skill_id` is **immutable and never reused** (like ADR-0028's occupation ids). A deprecated skill is marked `status='deprecated'`, never deleted or recycled, so historical rows stay meaningful.
- The vocabulary carries a **`taxonomyVersion`**. A version bump (new/merged/deprecated entries, re-embedding on a new model) triggers **re-embed + retag**: re-embed aliases, re-run resolution over open `unresolved_phrase` rows, and re-tag where the floor is now cleared — additively, behind the id space.

### (d) One pipeline for BOTH worker and job; the LLM never invents an id (SG-3)

- Worker profiling and job postings run the **same** `embed → domain-scoped match → id (or unresolved)` pipeline over the **same** vocabulary — so an adjacent-trade worker and an adjacent-trade job meet on the **same** `skill_id`, exactly as ADR-0028 makes them meet on the same occupation id.
- The **model emits skill phrases**; the **vector layer assigns the `skill_id`**. There is no path from a model string to a matchable `skill_id` except through the embed→match→floor→validate pipeline. This is the skills analogue of ADR-0028's `normalize_role_id` trust boundary — the model proposes, deterministic+vector code disposes.

---

## The seam — how this sits behind ADR-0028's `map_rich_to_legacy`

ADR-0028 routes model-emitted **rich labels** through `map_rich_to_legacy` (`profile_extractor.py`), which canonicalizes them to closed-set ids and re-validates via `normalize_role_id`. This ADR adds the **skills arm** of that same seam:

```
model-emitted rich labels
        │
        ├── occupation label ──► map_rich_to_legacy ──► normalize_role_id ──► canonical_role_id   (ADR-0028, unchanged)
        │
        └── skill phrase ──────► pseudonymize ──► embed ──► domain-scoped HNSW match ──► floor?
                                                                                          │
                                                                        ≥ floor ──────────┼──► skill_id  (closed, versioned space)
                                                                                          │
                                                                        < floor ──────────┴──► unresolved_phrase (pseudonymized, queued)
```

- The vector layer **outputs a `skill_id` in the same kind of closed, versioned, immutable id space** ADR-0028 defined for occupations. Both are validated closed-set ids; neither is free text.
- **ADR-0028's occupation ids are untouched.** This ADR does not change `canonical_role_id`, `canonical_trade_id`, the occupation crosswalk, or the mapper's occupation arm. Skills are an *additional* output of the same seam, not a change to the existing one.

---

## Invariant-#4 boundary (explicit) — canonicalization ≠ ranking

**The reach RANK core has no skills signal and no embeddings today. This ADR adds NEITHER to ranking.**

- The deterministic matcher (`packages/reach-engine`, ADR-0011/0015) scores on Role / Distance / Experience / Pay / Availability / Activity. **There is no skills factor and no vector/embedding input in the RANK path.** This ADR's embeddings live **only** in the *canonicalization* layer (resolve a phrase → an id); the resolved `skill_id` is a **profile/posting attribute**, not a ranking input.
- **Canonicalization ≠ ranking.** Turning "chhilai" into `skill_id=…milling…` is the same *class* of operation as turning "vmc operator" into `canonical_role_id` — it standardizes vocabulary; it does not score, rank, reject, or decide a match. Invariant #4 (LLMs assist; deterministic code decides) is **preserved**: the LLM emits phrases, the vector layer assigns ids, and the (deferred, deterministic) RANK core would consume ids — no LLM and no embedding ever ranks.
- **Skills-in-ranking is a SEPARATE, deferred decision.** Whether the RANK core ever gains a skills factor (and whether it uses `skill_id` overlap or embedding similarity) is **out of scope here** and requires **its own future ADR** with its own §2/#4 analysis. This ADR deliberately stops at canonicalization so that adopting a skill id space does **not** smuggle a learned/embedding ranking signal into the live path.
- **The live `worker_profiles.embedding` vector is ALSO out of the RANK path — and stays out.** A `vector(768)` column already exists on the ranking subject (`worker_profiles.embedding`, HNSW-indexed, documented "for semantic similarity", plans G3/G5) — it is **not** consumed by the deterministic RANK core today (`scoring.ts` `WEIGHTS` has no embedding/skills factor). This ADR does **not** wire it in, and TAX-1's `skill_alias.embedding` is a **canonicalization** artifact kept distinct from it. **Wiring EITHER embedding — the existing `worker_profiles.embedding` or this ADR's `skill_alias.embedding` — into the live ranking path requires the separate future skills-in-ranking ADR.** This ADR's fence covers both vectors, not just its own: no embedding of any kind enters RANK without that separate decision.

---

## §7 gates (enumerated — each blocks the phase that needs it)

Per CLAUDE.md §7, this ADR **logs** the escalations; it does not clear them. Each must be satisfied before the phase that depends on it may start.

| # | Gate | What must happen | Blocks |
|---|---|---|---|
| **(a)** | **Migration review of the 3 new tables + a SECOND HNSW index (§3 stack).** | pgvector availability is **already proven** (enabled in migration 0001; `worker_profiles.embedding` in use) — so this is **not** an availability question. The residual gate is real: a **migration-reviewer** pass on the 3 additive tables + the **capacity/latency cost of a SECOND HNSW index** (`skill_alias.embedding`) on the Supabase tier (HNSW build memory + query load). `CREATE EXTENSION IF NOT EXISTS vector` in the migration is a harmless idempotent no-op (already enabled). | **TAX-1** |
| **(b)** | **Embedding provider = real calls + spend (invariant #5, SG-4).** | Embedding generation is a **real provider call**. It stays behind `AI_ENABLE_REAL_CALLS=false` by default, requires a key, and runs **staging-first**. Record the embedding model + dimension (**768**, matching the existing `worker_profiles.embedding` / Vertex `text-multilingual-embedding-002` — confirm the exact model in TAX-3) and the per-1k-token cost in the cost tracker. | **TAX-3, TAX-4** |
| **(c)** | **ESCO / O\*NET licensing — INBOUND redistribution terms.** | Confirm and **record in this ADR / the register**: ESCO's exact licence (CC-BY-family — attribution + share terms) and O\*NET's public-domain-US status (+ attribution request). Do **not** import a source until its redistribution terms are confirmed. | **TAX-2** (import) |
| **(d)** | **RVM industrial-wedge ratification (human gate).** | The kharad/chhilai/ghisai/setting hand-seeds (their canonical mapping + aliases) are **human-ratified** by the owner/product — a wrong wedge mapping silently mis-matches real workers. | **TAX-5** |
| **(e)** | **Embedding provider — OUTBOUND data-usage / no-train terms.** | Worker-derived skill phrases (which may carry a residual employer name the pseudonymizer misses — see SG-1) **leave to a third-party provider** at embed time. Confirm and record the provider's **data-retention + does-it-train-on-submitted-text** terms **before** any staging real embedding run — parallel to how real-LLM-provider terms are governed. This is a new external **PII-egress surface**, distinct from (b)'s spend gate. | **TAX-3, TAX-4** |

---

## Rollout (phased — TAX-1…TAX-9; each its own PR, additive behind the `skill_id` space)

Mirrors ADR-0028's format: each phase enters only when its gate is met; each is independently reversible.

| Phase | Scope | Gate to ENTER |
|---|---|---|
| **0 — this ADR** | sources + seam + invariant-#4 boundary + §7 gates + phased design. No code. | — (Status: **Accepted**, owner directive 2026-07-14) |
| **1 — DB: `skill` / `skill_alias` / `unresolved_phrase` (+ HNSW)** | migration **0037** (head is already 0036 — `0036_worker_resume_prefs`): 3 additive tables on the **already-enabled** pgvector (idempotent `CREATE EXTENSION IF NOT EXISTS vector` is a no-op); immutable `skill_id`; `skill_alias.embedding vector(768)` (matches `worker_profiles.embedding`) + **HNSW (cosine)** index + a btree for the domain-scoped filter; `unresolved_phrase` (**pseudonymized** text, counts, status, **no `worker_id`**). All 3 tables `.enableRLS()`-in-model (service-role today; RLS not finalized). Additive; no shipped column touched. | ADR **Accepted** **AND** §7(a) — migration-reviewer pass + second-HNSW-index cost review |
| **2 — Seed vocabulary (labels + aliases, NO embeddings)** | import ESCO skills skeleton + O\*NET tool/machine depth + NCO occupation anchors into `skill`/`skill_alias` (text only). Pure data. | Phase 1 merged **AND** §7(c) licensing confirmed + recorded |
| **3 — Embedding provider seam** | add an `embed(phrase) → vector` capability behind the `LlmAdapter`/`AIRouter` seam (mock vector by default; real gated). Pseudonymize-before-embed. Record model + dimension + cost. | Phase 1 merged **AND** §7(b) real-call posture (default off, key, staging) |
| **4 — Embed the seeded aliases (backfill)** | populate `skill_alias.embedding` for the seeded vocabulary via a **staging-first** real embedding run; verify HNSW returns sensible neighbours. | Phases 2+3 merged **AND** §7(b) staging real-call sign-off |
| **5 — RVM wedge hand-seeds** | human-curated provisional skills + aliases for the shop-floor Hinglish/regional wedge (kharad/chhilai/ghisai/setting…), embedded like the rest. | Phase 2 merged **AND** §7(d) RVM wedge ratified (human) |
| **6 — Resolver pipeline (embed → match → id/unresolved)** | the `resolve(phrase, domain) → skill_id | unresolved` service: domain-scoped HNSW + confidence floor + below-floor → `unresolved_phrase`; wired into the **skills arm** of `map_rich_to_legacy` (worker side). LLM never assigns the id. | Phase 4 merged |
| **7 — Unresolved clustering + ops promotion queue** | cluster open `unresolved_phrase` rows (embedding) and surface recurring clusters for **human** promotion to `status='provisional'` skills. The growth loop. | Phase 6 merged |
| **8 — Job side adopts the same pipeline** | job-posting skill phrases resolve through the **same** resolver into the **same** `skill_id` space, so worker↔job meet on skill. | Phase 6 merged |
| **9 — Version + retag + eval/quality gate** | `taxonomyVersion` bump → re-embed + re-tag open unresolved rows; a resolution-quality eval (precision/recall vs the floor). **Any use of `skill_id` in the LIVE ranking path is explicitly OUT — that needs its own ADR.** | Phases 6+8 merged |

Each phase is additive behind the `skill_id` space; legacy `skill_*` ids (crosswalked in `@badabhai/taxonomy`) stay valid throughout.

---

## Invariant guardrails (this ADR asserts and preserves each)

- **SG-1 / §2 #2 (no raw PII) — treat worker-entered skill text as HOSTILE.** Skill phrases *should* describe capability, not the worker — but a worker can type anything (e.g. "worked at Bharat Forge as a turner"), so the phrase is treated as **untrusted input**, not assumed PII-free. `unresolved_phrase` stores **pseudonymized** text only, and no phone/name/employer may land in `skill`/`skill_alias`/`unresolved_phrase`, embeddings, events, `ai_jobs`, `audit_logs`, or logs. **Residual dependency (recorded, not hand-waved):** the guarantee is only as strong as `pseudonymize.py`, whose employer-name masking is **incomplete** — e.g. `_COMPANY_SUFFIX` lacks "Forge", so "Bharat Forge" is not masked, and fail-closed only trips on oversize/parse-error/**digit-run**, so a digit-free employer name is **not blocked** and would reach the embedding provider unmasked (**TD56**-adjacent). Closing this residual (harden employer masking / real NER, TD3/TD56) is a **precondition** for the TAX-3/4 staging real-embedding run.
- **SG-2 / §2 #3 (pseudonymize fail-closed) — and a NEW external PII-egress surface.** Every phrase passes through the pseudonymizer **before** it is embedded — same fail-closed gate as every other LLM path. But embedding a phrase means it **leaves to a third-party provider**: this is a **new external PII-egress surface** (not just "same as every LLM path"), gated by §7(e) (provider data-retention/no-train terms) and bounded by the SG-1 residual above. If pseudonymization blocks, no embedding call is made.
- **SG-3 / §2 #4 (LLMs assist, never decide).** The LLM emits phrases; the **vector layer** assigns the `skill_id`; the model **never invents a `skill_id`**. The resolver's returned id is **re-validated against the `skill` table on write** (mirroring ADR-0028's `normalize_role_id`), so even the vector step cannot emit an id absent from the closed set. Canonicalization is not ranking; no LLM or embedding enters the RANK path (see §Invariant-#4 boundary).
- **SG-4 / §2 #5 (real calls gated, off by default).** Embedding generation requires `AI_ENABLE_REAL_CALLS=true` + a key and runs **staging-first**; default is mock/off. No phase flips this implicitly.
- **SG-5 / §2 #8 (additive + versioned).** All 3 tables are **purely additive** (no shipped column/event mutated; no contract step — nothing to expand→migrate→contract here, unlike ADR-0028's column versioning). pgvector is already enabled. `skill_id` is immutable/never-reused; the vocabulary is versioned; every phase carries a rollback note.
- **RLS posture (TAX-1).** `unresolved_phrase` holds worker-derived content, so the 3 new tables are committed to the same **`.enableRLS()`-in-model** posture the spine tables carry (service-role backend today; RLS **not finalized** here — `infra/supabase/rls-plan.md`), so TAX-1 does not ship them RLS-naked.
- **DSAR / erasure (TAX-1 records the posture).** `unresolved_phrase` stores pseudonymized worker-derived text + counts, retained for the TAX-7 clustering loop. TAX-1 must **declare** whether a row references the worker: the design intent is **NO `worker_id`** — an aggregate `(pseudonymized phrase, domain, count)` queue with no per-worker link — so it is **not** a per-worker DSAR surface under [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md) account deletion. If a later phase ever adds a worker link, it becomes a DSAR surface and must be wired into ADR-0026 erasure (cf. the voice-audio DSAR launch-gate).

---

## Consequences

- **Positive:** free-text worker/job skills finally resolve to **one** canonical, standard-backed, India-named `skill_id` space, so adjacent supply and demand can meet on skill (impossible today — no skill id space exists). Vector similarity over aliases generalizes across spelling/dialect variants a keyword gazetteer can't; the confidence floor + unresolved queue means the system **never fabricates** a match and **grows from real demand** under human gates. The id space is **closed + immutable** (strictly safer than free text), the LLM stays assist-only, and **ranking is untouched** (no skills/embedding signal added to the live path).
- **Negative / risk:** a real embedding provider (spend **and** a new external PII-egress surface with its own data-retention terms), external-standard licensing, and a hand-curated wedge — **five §7 surfaces** (a–e), each a gate. (pgvector itself is **not** new — already enabled since migration 0001.) Embedding quality + the floor value are empirical (TAX-9 eval); too low a floor mis-matches, too high drops real skills to unresolved. Maintaining four sources' crosswalk + the RVM wedge needs a named owner + review cadence (as ADR-0028 OQ#2 already flags for occupations). Bringing a skill genuinely in-scope still depends on Phase-1 profiling covering it, not just on its presence in the vocabulary.
- **Rollback story (per phase):** every phase is additive behind the `skill_id` space. TAX-1 = revert migration + drop the 3 tables + extension (nothing shipped depends on them). TAX-2/4/5 = data only (truncate/revert). TAX-3/6/8 = revert the consumer; the seam falls back to occupation-only canonicalization (ADR-0028), unchanged. TAX-7/9 = ops/version tooling, revert in isolation. No shipped profile/posting loses classification because occupation ids (ADR-0028) are independent and untouched.

---

## Alternatives considered

1. **Keep the ad-hoc CNC/VMC skill gazetteer, hand-widen it.** Rejected: no standard, no interop, brittle to spelling/dialect, and it never gives worker↔job a *shared* skill id — it perpetuates exactly the gap ADR-0028 closed for occupations but leaves open for skills.
2. **Let the LLM emit `skill_id`s directly (prompt it with the closed set).** Rejected: violates invariant #4 / SG-3 — the model would be minting matchable ids; hallucination + drift risk; no generalization guarantee. The vector layer assigns ids deterministically; the model only reads phrases.
3. **Exact/fuzzy string match (trigram) instead of embeddings.** Rejected as the *primary* mechanism: trigram catches typos but not semantic variants ("setting" ↔ "machine setup", "chhilai" ↔ "milling"); it can't cross Hinglish↔English. Embeddings generalize; the floor + unresolved queue bound the risk. (Trigram may still assist as a cheap pre-filter — a TAX-6 implementation detail, not an architecture change.)
4. **Wire an embedding (this ADR's `skill_alias.embedding` or the existing `worker_profiles.embedding`) straight into ranking.** Rejected: that conflates canonicalization with ranking and would introduce an embedding signal into the live path — a separate decision requiring its own ADR (see §Invariant-#4 boundary). This ADR deliberately keeps **all** embeddings out of RANK.
5. **ESCO alone (skills) / O\*NET alone.** Rejected in favour of the four-pillar blend: ESCO gives the skills skeleton but is EU-shaped; O\*NET gives tool/machine depth but is US-labour-shaped; NCO gives India occupation names; the **RVM wedge** is the only source for the shop-floor Hinglish/regional skills — none alone covers Indian industrial-manufacturing reality.

---

## Downstream-phase PR checklist (every TAX-1…TAX-9 PR must tick)

- [ ] **Gate met:** the phase's enter-gate in the Rollout table is satisfied (ADR Accepted; the relevant §7 gate cleared) — cite it in the PR.
- [ ] **Additive only (SG-5):** no shipped column/event mutated; `skill_id` immutable/never-reused; rollback note included.
- [ ] **PII boundary (SG-1/SG-2):** no raw PII in `skill`/`skill_alias`/`unresolved_phrase`/embeddings/events/`ai_jobs`/`audit_logs`/logs; `unresolved_phrase` stores pseudonymized text; pseudonymize-before-embed.
- [ ] **AI stays assist-only (SG-3 / invariant #4):** the LLM never assigns a `skill_id`; **no skills/embedding signal added to the RANK path** (that needs its own ADR).
- [ ] **Real calls gated (SG-4):** any embedding call is behind `AI_ENABLE_REAL_CALLS` + key, staging-first, default off.
- [ ] **Typed contracts (invariant #7):** Zod ↔ Pydantic parity for any new I/O; taxonomy version recorded.
- [ ] **Reviewed:** `bb-architecture-review` for seam changes; `security-engineer` / `bb-security-review` for any PII/embedding boundary; `migration-reviewer` for TAX-1's migration.

---

## Related

- **ADR-0028** (`0028-international-occupation-taxonomy-adoption.md`) — the occupation spine this amends; **its Open Question #1 is resolved here**.
- ADR-0008 (`0008-litellm-to-direct-providers.md`) — LLMs assist, never decide (the model emits phrases; the vector layer assigns ids).
- ADR-0011 / ADR-0015 (`0011-reach-feed-serving.md`, `0015-reach-feed-on-real-jobs.md`) — the deterministic RANK core this ADR keeps **skills-free and embedding-free**.
- `worker_profiles.embedding` (schema.ts ~L364, `vector(768)` + HNSW) — the existing live semantic-similarity vector on the ranking subject; **also** kept out of the RANK path by this ADR (either embedding into ranking needs the separate skills-in-ranking ADR).
- `packages/taxonomy/src/index.ts` — versioned home of the legacy-`skill_*` → standard crosswalk.
- `apps/ai-service/app/profiling/signals.py`, `profile_extractor.py` (`map_rich_to_legacy`) — the mapper seam the resolver plugs into (skills arm).
- `apps/ai-service/app/pseudonymize.py` — fail-closed gate before every embed.
- `packages/db/src/schema.ts` — 36 tables today; **pgvector already enabled (mig 0001)** and `worker_profiles.embedding vector(768)` already present; TAX-1 adds **3 additive tables** (→ 39) using the existing extension + 768 dimension.
- `packages/reach-engine` — the deterministic matcher; **out of scope for this ADR** (skills-in-ranking = a separate future ADR).
- `infra/supabase/rls-plan.md` — RLS posture for the 3 new tables (deferred; backend service-role today) — noted, not finalized, in TAX-1.
- CLAUDE.md §2 invariants 1/2/3/4/5/7/8, §3 locked stack, §7 escalation; the `migration` + `bb-architecture-review` + `bb-security-review` skills.

*This ADR records the architecture decision to resolve ADR-0028 Open Question #1 by adopting a standard-backed (ESCO + O\*NET + NCO-2015 + RVM), embedding-canonicalized, immutable SKILL id space behind the existing mapper seam (2026-07-14). It authorizes a phased, additive, versioned, gated rollout (TAX-1…TAX-9); it produces **no code, schema, migration, extension, import, or embedding call**. **Skills-in-ranking is explicitly out of scope and requires its own ADR — invariant #4 is untouched.** Accepted by owner directive (2026-07-14) after the security-engineer read's blocking corrections were folded in; downstream phases (TAX-2…TAX-9) still hold at their §7 gates (b–e).*
