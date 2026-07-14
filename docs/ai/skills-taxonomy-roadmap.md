# Skills Taxonomy Roadmap (ADR-0030 / TAX-0…TAX-9)

Status board + per-task scope so a coding agent can pull each block by id. The authority of
record is [ADR-0030](../decisions/0030-embedding-skill-canonicalization.md). Every task below
preserves **invariant #4**: the vector layer **canonicalizes** (assigns `skill_id`), it **never
ranks** — a skills factor in RANK is a *separate future ADR*, explicitly out of scope here.

## Invariant IDs referenced (from ADR-0030)

- **SG-1** — `unresolved_phrase` stores **pseudonymized** text only.
- **SG-2** — pseudonymize **before** embed, **fail-closed**.
- **SG-3** — canonicalize **assigns** an id from the closed set; **never invents, never ranks**.
- **SG-4** — real embedding provider is gated (`AI_ENABLE_REAL_CALLS` + key + `skill_embedding`
  allowlist, staging-first). Default is a deterministic **mock** embedding (zero spend).
- **SG-5** — aliases additive; **`skill_id` immutable, never reused**; change = version + status
  transition + offline re-tag (expand→migrate→contract).
- **SG-7** — typed I/O contract, **Zod ↔ Pydantic** parity.
- **§7 / human gates** — new datastore, real spend, licensing, and **RVM domain ratification**
  of vernacular mappings are human sign-offs.

## Status board

| Task | Type | Prio | Status | Blocked-by | PR |
|---|---|---|---|---|---|
| TAX-0 | ADR | — | **MERGED** (Accepted) | — | #211 |
| TAX-1 | DB (pgvector + 3 tables, migration 0037) | — | **MERGED** | TAX-0 | #212 |
| TAX-2 | Corpus import (ESCO/O*NET/NCO) + seed | — | **MERGED** | TAX-1 | #213 |
| TAX-3 | AI — alias embedding (mock default, real §7) | — | **MERGED** | TAX-2 | #214 |
| TAX-4 | AI — `canonicalize_skill` (floor-gated) | — | **MERGED** | TAX-3 | #215 |
| **fork-B runner** | DB-side runner + ai embed endpoint | — | **NEXT** (owner chose B) | TAX-3/4 | — |
| TAX-5 | Data/AI — wedge aliases + floor calibration | **P1** | Unblocked · **2 gates** | TAX-4 | — |
| TAX-6 | Backend+AI — job side shares id space | P2 | Unblocked | TAX-4 | — |
| TAX-7 | AI — growth loop (cluster unresolved) | P2 | Unblocked | TAX-4 | — |
| TAX-8 | QA+AI — off-wedge résumé verify | P2 | Unblocked | TAX-4 | — |
| TAX-9 | DB+AI — versioning + offline re-tag | P3 | Unblocked | TAX-4/6 | — |

## Done (TAX-0…TAX-4)

pgvector was already enabled (migration 0001) and **768 is the house dimension**
(`worker_profiles.embedding`). TAX-1 added `skill` / `skill_alias` / `unresolved_phrase`
(all RLS-spined). TAX-2 seeded a **curated ESCO(CC-BY)/O*NET(CC-BY)/NCO(GODL)** starter corpus
in BadaBhai's own immutable `skill_id` space (no invented source codes;
[PROVENANCE.md](../../packages/taxonomy/PROVENANCE.md)). TAX-3 added
`apps/ai-service/app/ai/embeddings.py` (`embed_text` pseudonymizes-first, mock 768-vec default,
real Gemini §7-gated). TAX-4 added `apps/ai-service/app/ai/canonicalize.py`
(`canonicalize_skill(phrase, domain_id) → {skill_id, score} | UNRESOLVED`, floor 0.82,
never-invents, miss records pseudonymized text, wired into `map_rich_to_legacy` behind
`skill_canonicalize_enabled`, default OFF).

## fork-B — DB-side runner (owner-chosen 2026-07-14)

The ai-service is **DB-free** and `skill_alias` is REVOKE'd from the Data-API role, so the real
vector read/write lives in a **`packages/db` runner (owner connection)** that calls the
ai-service embed over HTTP — **not** a psycopg client inside the ai-service (option A rejected).
Populates `skill_alias.embedding` (mock by default → runnable now with no spend; real is SG-4).
Prerequisite for TAX-5's *real* calibration and TAX-7's *real* clustering.

## TAX-5 — Wedge aliases + floor calibration · **P1** · owner: ai + RVM

High match precision on the 7 launch roles + machine families, incl. vernacular shop-floor terms
the standards miss (kharad=lathe, chhilai=milling/finishing…), and a floor value justified by a
labeled set. **Two human/§7 gates:** (a) **RVM domain owner ratifies** the vernacular→standard
mappings (SG-3/TAX-0 human gate — I *propose*, human *approves*); (b) a *meaningful* floor
sweep needs **real semantic embeddings** (SG-4/§7) — on the mock embedder cosine is ≈0 for
different text and 1.0 for identical, so a mock sweep only validates plumbing (seeded terms
resolve, hard negatives stay UNRESOLVED), not the value. Buildable now: labeled wedge eval set,
`pytest -k wedge` harness, **proposed** `source=rvm` lang-tagged aliases, and sweep tooling;
floor stays the recorded default **0.82** until calibrated. **Do NOT** seed non-launch trades
(TAX-7/8) or touch ranking. Files: `packages/taxonomy/src/wedge-aliases.*`,
`apps/ai-service/tests/wedge_eval/*`, floor config.

## TAX-6 — Job side shares the id space · P2 · owner: backend + ai

Job postings canonicalize their skill phrases through the **same** `canonicalize_skill` pipeline
→ both sides key on one id space (the ADR-0028 promise on the skills dimension). Store `skill_ids`
**additively** (new column/jsonb, expand→migrate→contract, SG-5). **RANK is byte-for-byte
unchanged** — regression-lock the reach-engine scoring suite + a **guard test that no skills field
enters RANK inputs** (SG-3 / invariant #4). **Do NOT** change `packages/reach-engine`
scoring/weights or add any skills factor to RANK. Proof test: a worker phrase and a job phrase for
the same skill produce the **same** `skill_id`. Files: `apps/api/src/` (job-postings),
`packages/db/schema.ts` (additive), ai-service reuse, tests.

## TAX-7 — Growth loop: cluster unresolved → alias/provisional · P2 · owner: ai

Weekly offline job: embed (if needed) + cluster `unresolved_phrase` by cosine, rank by frequency;
each cluster proposes either a **new alias** on a near existing skill (within a floor band) or a
**new provisional skill** (`status='provisional'`, `source='rvm'`, new immutable id). Proposals go
to a **review surface** — **nothing auto-activates** (provisional is the automation ceiling);
human approval → seed (reuse TAX-2/3) → mark cluster resolved → optionally re-canonicalize covered
phrases. Guards: frequency threshold + min-cluster-size. Files: `apps/ai-service/app/growth.py`,
a review-surface hook (register/ops event), tests (`pytest -k growth`).

## TAX-8 — Off-wedge résumé verify · P2 · owner: qa + ai

**Verification/guard task, not a new builder.** Prove (and lock with tests) that UNRESOLVED /
out-of-launch-scope skills **degrade gracefully**: the résumé renders from the worker-confirmed
**raw phrases**; a canonical `skill_id` is attached as **metadata only** when available;
canonicalization **never blocks** résumé generation and never raises into it. `RESUME_SYSTEM_PROMPT`
untouched (AI-PERSONA-1 scope). **Do NOT** build a separate off-wedge generator or gate résumé on
canonicalization. Tests (`pytest -k resume`): launch-role (ids resolve), adjacent-trade
(out-of-scope id), novel skill (UNRESOLVED) — all produce a complete résumé; baseline snapshot
unchanged. OQ#3 (out-of-scope worker experience) is a product decision — flag, don't decide.

## TAX-9 — Versioning + offline re-tag discipline · P3 · owner: db + ai

Ids are immutable/never-reused; change is expressed by **version bump + status transition +
offline re-tag** of affected worker/job rows — **never on the live path** (SG-5/§8). Adds the
`active→deprecated` / `provisional→active` state machine + a `replaced_by` crosswalk on `skill`,
and an **offline retag job** (dry-run + apply, with a change report) that re-canonicalizes a
deprecated skill's rows to the replacement id. **Do NOT** live-retag or reuse ids. Documented in
the ADR-0030 rollout + the `migration` skill. Files: `packages/db/schema.ts` (extend TAX-1),
`apps/ai-service/app/retag.py`, ADR-0030, tests (`pytest -k retag`).
