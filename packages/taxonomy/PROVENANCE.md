# Skill corpus — provenance & licensing (ADR-0030 / TAX-2)

This package's canonical **skill vocabulary** (`src/skill-corpus.ts`) is assembled from the
four ADR-0030 pillars. Each `skill` / `skill_alias` row records its `source`. This file is
the licence + attribution record that the §7(c) gate (ADR-0030) requires **before** any
source data is committed.

> **Honest scope.** The committed corpus is a **curated STARTER subset** for the CNC/VMC +
> adjacent-trade wedge — real skill concepts in BadaBhai's **own immutable `skill_id`
> space**, each tagged with the standard the concept derives from. It is **not** the full
> bulk import of the ESCO (~13k skills) / O\*NET / NCO databases, and it **asserts no
> official source codes** it cannot verify (our `skill_id` is the authority — ADR-0030).
> The full bulk import (official source files) is a follow-up that seeds through the **same**
> loader (`packages/db/src/seed-skills.ts`). The RVM Hinglish shop-floor wedge
> (kharad/chhilai/…) + its aliases are **TAX-5**, not this corpus.

## Sources & licences (verified 2026-07-14)

| `source` | What it contributes | Licence | Attribution obligation |
|---|---|---|---|
| **`esco`** | The **skills skeleton** (skill/competence concepts occupations lack). | **CC-BY 4.0** — free to download, adapt, and redistribute. ([copyright notice](https://esco.ec.europa.eu/en/copyright-notice-esco-skills-competences)) | Credit "European Commission — ESCO", link the original + the CC-BY-4.0 licence, and state changes. |
| **`onet`** | **Tool / machine / technology** depth (equipment, controllers, techniques). | **CC-BY 4.0** — *not* pure public domain (a correction to the ADR-0030/TAX-1 assumption; O\*NET moved to CC-BY). ([O\*NET licence](https://www.onetonline.org/help/license)) | Credit "U.S. Department of Labor, Employment & Training Administration (O\*NET)" as the original source. |
| **`nco`** | **India occupation-name** anchors (NCO-2015, ISCO-08-aligned; DGE, Ministry of Labour & Employment). | **Government Open Data License – India (GODL-India)** (gazette 2017-02-13) — permits adapt/publish/translate/derivative for commercial + non-commercial use. ([GODL-India](https://www.data.gov.in/Godl)) | Credit "Directorate General of Employment (DGE), Government of India — NCO-2015". **Residual:** confirm NCO-2015 is specifically released under GODL before the bulk import (§7(c) data-owner check). |
| **`rvm`** | The **9 legacy first-party placeholder** skills (from `index.ts`, preserved) — BadaBhai-authored, not imported from a standard. | First-party (BadaBhai). | — |

**All three external sources are redistributable with attribution**, so the §7(c) gate does
not block the starter corpus. The attribution strings above must ship with any user-facing
surface that exposes the vocabulary, and the **NCO GODL residual** is the one item a
data-owner must confirm before the full NCO bulk import.

## Invariants honoured

- **Immutable ids (ADR-0030 SG-5).** `skill_id` is never renamed or reused. The 9 legacy
  `skill_*` placeholder ids are preserved verbatim (`LEGACY_SKILL_IDS`).
- **Versioned.** `SKILL_TAXONOMY_VERSION` bumps on every additive change; a re-tag never
  renames.
- **No PII / no embeddings here.** Reference vocabulary only; `skill_alias.embedding` stays
  NULL until TAX-3/4 (a gated real provider call).

## How to seed

```bash
pnpm build                 # build @badabhai/taxonomy so the corpus resolves
pnpm db:seed:skills        # idempotent, prod-guarded; double-run → identical row counts
pnpm db:embed:skills       # fork-B runner: fills skill_alias.embedding via the ai-service
                           # (start it first; MOCK vectors by default — real is §7-gated,
                           # see docs/ai/skills-taxonomy-roadmap.md staging runbook)
```

## Embedding model (TAX-3)

`skill_alias.embedding` is a **`vector(768)`** column — confirmed to match the ai-service
embedder (`apps/ai-service/app/ai/embeddings.py`, `EMBEDDING_DIMENSION = 768`) and the
existing `worker_profiles.embedding`. The configured real model is `text-embedding-004`
(Gemini Developer API, 768-dim; `Settings.embedding_model`); the **default path is a
deterministic MOCK embedding** (zero spend). The real embedding call is **§7-gated**
(`AI_ENABLE_REAL_CALLS` + key + the `skill_embedding` task allowlist, staging-first) — the
exact model + 768-dim output are **confirmed at the first gated staging run** (TAX-3/TAX-4).

