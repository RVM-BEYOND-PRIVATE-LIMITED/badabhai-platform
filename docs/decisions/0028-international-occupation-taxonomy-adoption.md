# ADR-0028: Adopt an international-standard occupation taxonomy (NCO-2015 / ISCO-08) as the shared canonical spine for worker profiling AND job postings

- **Status:** **Proposed** (owner decision of record, 2026-07-08). Architecture gate only — this ADR draws the seam and the phased rollout; it produces **no code, schema, or migration**. Implementation is handed to the engineer agents per phase, each its own PR.
- **Date:** 2026-07-08
- **Phase:** cross-cutting foundation. **NOT a §2 invariant relaxation** — it EXPANDS the closed canonical whitelist to a standard set and keeps every gate. It does **not** open Phase-2 scope; the matcher stays the deterministic, deferred-by-default RANK core.
- **Author:** system-architect (placement + contracts). Database-architect owns the migration (expand→migrate→contract). AI-engineer owns the ai-service mapper alignment. Backend-engineer owns the job-posting trade fields + the reach `JobSource` bridge. Security-engineer confirms the expanded whitelist stays a closed set (no free text into matchable fields) and the pseudonymizer boundary is unchanged.
- **Builds on / reconciles (verified against the repo, 2026-07-08):**
  - **ADR-0008** (`docs/decisions/0008-litellm-to-direct-providers.md`) — LLMs assist (profile / canonicalize / explain), never rank or decide. The mapper this ADR plugs into writes only VALIDATED closed-set ids; the taxonomy expansion does not change that boundary.
  - **ADR-0011 / ADR-0015** (`0011-reach-feed-serving.md`, `0015-reach-feed-on-real-jobs.md`) — the deterministic RANK core keys the Role factor on an **exact match** of `job.roleIds` against a worker's `canonical_role_id`. Today the job side gets `roleIds` from the ad-hoc `roleIdsForTradeKey` crosswalk in `apps/api/src/resume/trade-content.ts` (`taxonomy_role_ids`), where the 5 machining trades map to the 7 worker roles and the other 10 trades yield `[]`. **This is the exact gap this ADR closes.** The RANK math/weights are untouched — only the id space both sides key on becomes a shared standard.
  - **ADR-0022** (`0022-agency-supply-portal.md`) — the agency (`payers.role='agent'`) demand slice reuses the SAME `jobs`/`job_postings` + reach projection; adopting shared ids benefits the agency surface identically, faceless and event-first.
  - **ADR-0027** (`0027-org-tenancy.md`) — org tenancy is orthogonal; this ADR touches occupation classification, not the payer principal or tenant chokepoint.
  - **`packages/taxonomy/src/index.ts`** — the current placeholder taxonomy: 1 industry, 5 domains, **7 canonical `role_*` ids**, 9 `skill_*` ids, 5 `mach_*` ids. Header already commits: "existing ids must remain stable." This package becomes the versioned source of truth for the standard mapping.
  - **`apps/ai-service/app/profiling/signals.py` + `canonical_roles.py`** — the ad-hoc CNC/VMC gazetteer (`_ROLES` = 8 keyword rows → 7 distinct `role_*` ids; `_SKILLS`, `_MACHINES`, `_CONTROLLERS`) is TODAY the runtime taxonomy authority; `canonical_roles.ROLE_TRADE`/`ROLE_IDS` derive the closed allow-set offered to the model, and `normalize_role_id` is the LLM-output trust boundary.
  - **`apps/ai-service/app/profiling/profile_extractor.py`** (`map_rich_to_legacy`, on branch `fix/ai-service-canonicalization-and-diagnostics`) — the mapper seam: it canonicalizes MODEL-emitted rich labels → the closed-set `canonical_role_id` / `machines[]` / `skills[]` via the gazetteer reverse-lookups, re-validated through `normalize_role_id`, and marks a profile that canonicalizes to NOTHING (e.g. a welder) via `unmatchable_reason` (`is_outside_cnc_vmc_scope`). **This is the single seam this adoption plugs into.**
  - **`packages/db/src/schema.ts`** — `worker_profiles.canonical_trade_id` / `canonical_role_id` (text, ~L346), `jobs.trade_key` (`TradeKey`, NOT NULL, ~L855; one of the 15 alpha trade keys). These are the columns a later phase versions.
  - CLAUDE.md §2 invariants #1 (event-first), #2 (no raw PII), #3 (pseudonymize fail-closed), #4 (LLMs never rank/decide), #7 (typed contracts), #8 (backward-compatible / versioned); §3 locked stack; §7 escalation.

---

## Context

The ai-service profiling pipeline canonicalizes a worker's trade / role / skills against a **LOCAL, ad-hoc CNC/VMC gazetteer** — `apps/ai-service/app/profiling/signals.py` (`_ROLES` / `_SKILLS` / `_MACHINES` / `_CONTROLLERS`), mirrored as stable placeholder ids in `packages/taxonomy`. It is exactly 7 canonical `role_*` ids covering CNC/VMC machining and nothing else. Two structural problems fall out of that:

1. **Adjacent trades drop to empty by construction.** A welder (`"mig_tig_welder"`), a fitter, an electrician, a fabricator — anything outside the 7-role machining set — canonicalizes to NOTHING. The mapper handles this honestly (`is_outside_cnc_vmc_scope` → `unmatchable_reason`, an advisory adjacency flag, not a hard reject), but the worker's `canonical_role_id` / `canonical_trade_id` come back **null**. This is an explicit *negative* case in the ai-service tests, and it is the correct behaviour for a machining-only whitelist — but it means a real, employable adjacent-trade worker carries no canonical occupation.

2. **Workers and job postings do not share an occupation taxonomy.** Worker profiles canonicalize into `role_*` ids (from the ai-service gazetteer). Job postings classify by `jobs.trade_key` — one of **15** free-standing `TradeKey` slugs. The only bridge is the hand-authored `roleIdsForTradeKey` map in `apps/api/src/resume/trade-content.ts` (`taxonomy_role_ids`), which maps the 5 machining trades onto the 7 roles and yields `[]` for the other 10 (ADR-0015 §4). Because the two sides key on **different id spaces** joined by an ad-hoc, machining-only crosswalk, **cross-matching an adjacent-trade worker to an adjacent-trade job posting is impossible** — even when both sides describe the same real occupation, they never meet on a shared id.

A `map_rich_to_legacy` mapper was just built in ai-service (`profile_extractor.py`, on `fix/ai-service-canonicalization-and-diagnostics`). It is the clean seam: it takes model-emitted rich labels and canonicalizes them to closed-set ids, re-validating through `normalize_role_id` so no hallucinated/free-text id can enter a matchable field. **Widening the id space is now a matter of widening the closed set the mapper targets — the seam already exists; it just points at an 8-row gazetteer today.**

The owner (2026-07-08) directed the fix: **adopt an international-standard occupation taxonomy — NCO-2015 (India's National Classification of Occupations, ISCO-08-aligned) — plus a rich→legacy mapper, SHARED across worker profiling AND job postings.** This spans `packages/taxonomy` + ai-service + the payer job-posting trade fields + the matcher (`packages/reach-engine`) + the DB (a versioned column migration) — bigger than ai-service, so it is an ADR of record with a phased rollout, not an inline build.

---

## Decision

**Adopt NCO-2015 (ISCO-08-aligned) as the SHARED canonical occupation/skill taxonomy across worker profiling and job postings**, behind the existing mapper seam, additively and versioned.

### (a) `packages/taxonomy` becomes the versioned source of truth

`@badabhai/taxonomy` stops being a "placeholder" package and becomes the **single versioned authority** for canonical occupation ids: NCO-2015 / ISCO-08 occupation codes (with human labels + aliases), a skill taxonomy keyed to it, and — critically — a **crosswalk from the current 7-role set to the standard codes** so nothing already shipped breaks. The package carries an explicit `taxonomyVersion`; ids are additive-only and **never renamed** (the package header already commits to id stability — this ADR ratifies it as a hard rule with a version field).

- The gazetteer in `signals.py` stops being the *authority* and becomes a **detection/heuristic** layer that produces labels; the authority for the closed set of valid ids moves to the shared taxonomy the mapper validates against.
- Both consumers — the ai-service mapper and the API/reach job side — import their canonical ids from this one package (directly in TS; mirrored in Python as today `packages/taxonomy` is mirrored into `signals.py`). One id space, two consumers.

### (b) The ai-service mapper canonicalizes to the standard ids

`map_rich_to_legacy` (and the `canonical_roles` allow-set / `normalize_role_id` trust boundary it depends on) target the **expanded standard closed set** instead of the 8-row machining gazetteer. The mapper contract is unchanged: model-emitted rich labels → VALIDATED closed-set ids, hallucinated/free-text rejected, nothing outside the set enters `canonical_role_id`. Adjacent trades that today go null instead resolve to their NCO/ISCO code once that code is in the whitelist. `unmatchable_reason` / `is_outside_cnc_vmc_scope` is retained as the honest-adjacency flag for whatever remains genuinely out-of-scope (see Open questions).

### (c) Job postings + the matcher consume the SAME ids

`jobs.trade_key` (and the `job_postings` trade fields) gain a canonical occupation id from the shared taxonomy; the `roleIdsForTradeKey` crosswalk in `trade-content.ts` is replaced by (or re-expressed over) the shared taxonomy crosswalk. The reach `JobSource` bridge (`reach.job-source.ts`, ADR-0015 §4) then builds `job.roleIds` from the shared ids, and the RANK core's Role factor exact-matches a worker's `canonical_role_id` against them — **on the same standard id space, so an adjacent-trade worker and an adjacent-trade job now meet.** The RANK math, weights (Role .35 / Distance .20 / Experience .15 / Pay .10 / Availability .10 / Activity .10), and the deferred/serving posture are **untouched** — only the id space both sides key on changes.

### (d) Invariants preserved — this EXPANDS the whitelist, it does not loosen it

- **Still a CLOSED set (invariant #2/#4 boundary).** NCO/ISCO is a **larger** enumerated whitelist, not free text. The mapper still writes only ids that exist in the taxonomy; `normalize_role_id` still rejects anything else. There is no path from a model string to a matchable field except through a validated standard id. A richer, standardized whitelist is strictly safer than an ad-hoc 7-item one — never looser.
- **AI stays assist-only (invariant #4).** The model proposes labels; deterministic code maps them to ids and validates them; the RANK core (deterministic, no LLM) does the matching. No LLM ranks, scores, or decides — the standard taxonomy changes the *vocabulary*, not who decides.
- **Pseudonymization boundary unchanged (invariant #3).** Occupation ids are profile signals, not identity PII; the pseudonymizer path is not touched by this ADR. (An unrelated, pre-existing masking gap surfaced during the ai-service fix is logged separately as TD56.)
- **Additive + VERSIONED migration (invariant #8).** The DB change is expand→migrate→contract: add the new canonical-id column(s) alongside the existing `trade_key` / `canonical_role_id`, dual-write + backfill, and only contract once every consumer reads the new ids — backward-compatible throughout, no shipped column dropped and no shipped event payload mutated. Cross-ref the **`migration` skill** (`.claude/skills/`) for the expand/contract discipline and the rollback note each phase carries.

---

## Rollout (phased — each phase its own PR, behind the seam, NON-blocking to the ai-service diagnostics fix)

This adoption **does not block Track A** — the in-flight ai-service canonicalization + diagnostics fix (`fix/ai-service-canonicalization-and-diagnostics`, which shipped `map_rich_to_legacy` + typed transport diagnostics). Track A lands on the current 7-role gazetteer; this ADR then widens the id space underneath the same seam. The WS4 mapper backfill is explicitly gated behind Track A's staging `--real` negative-tier eval (the pinned TODO), so no phase here forces the diagnostics fix to wait.

| Phase | Scope | Gate to ENTER |
|---|---|---|
| **0 — this ADR** | classification + seam + phased design. No code. | — (you are here; Status: Proposed) |
| **1 — taxonomy package** | `@badabhai/taxonomy` gains NCO-2015 / ISCO-08 occupation + skill ids (versioned, `taxonomyVersion`), plus a **crosswalk from the current 7-role set** so existing `role_*` ids remain valid/stable. Pure data + types; no consumer flips yet. | ADR accepted |
| **2 — ai-service aligns + WS4 backfill** | `signals.py` / `canonical_roles.py` / `map_rich_to_legacy` target the expanded closed set; the allow-set offered to the model + `normalize_role_id` validate against it. **WIRE the mapper backfill** (re-canonicalize adjacent-trade drafts to their standard code). | Phase 1 merged **AND** Track A's staging `--real` negative-tier eval passes (the pinned TODO) — the backfill does not flip until the real-run eval confirms the expanded whitelist does not regress the negative (out-of-scope) tier. |
| **3 — job-posting trade fields adopt the ids** | `jobs` / `job_postings` trade fields carry the shared canonical occupation id; `roleIdsForTradeKey` re-expressed over the shared crosswalk. Additive column; `trade_key` retained. | Phase 1 merged |
| **4 — matcher keys on shared ids** | reach `JobSource` builds `job.roleIds` from the shared ids; the RANK Role factor matches worker `canonical_role_id` on the same space. No RANK math/weight change. | Phase 3 merged |
| **5 — DB columns + backfill (contract)** | version `worker_profiles.canonical_*` / `jobs.trade_key` to the standard ids via expand→migrate→contract; backfill existing rows through the crosswalk; contract only once all consumers read the new ids. | Phases 2–4 merged; migration + rollback note reviewed (`migration` skill) |

Each phase is independently reversible: revert the phase's PR; earlier phases keep working because the crosswalk keeps the legacy `role_*` ids valid throughout.

---

## Consequences

- **Positive:** worker profiles and job postings finally share ONE standard occupation id space, so cross-matching an adjacent-trade worker to an adjacent-trade job becomes *possible* (it is impossible today). The whitelist gets richer and standards-based (ISCO-08 interop, NCO-2015 India-fit) while staying a **closed set** — strictly safer than the ad-hoc 7-item gazetteer, never looser. The mapper seam already exists, so the ai-service change is "point the validator at a bigger set," not a rewrite. Reusing the existing `taxonomy` package + `roleIdsForTradeKey` crosswalk means no new framework/datastore (§3 stays locked). The reach RANK core is untouched, so ranking behaviour is unchanged except for the wider id space it can now match on.
- **Negative / risk:** a larger taxonomy is a larger surface to author and keep crosswalked; the crosswalk (7-role → NCO/ISCO, and 15 `trade_key` → NCO/ISCO) needs a clear owner and a review pass (Open questions). Skill-taxonomy granularity is a real modelling decision (ISCO codes occupations, not skills). The DB migration touches shipped classification columns, so the expand→migrate→contract discipline and per-phase rollback notes are mandatory. Bringing adjacent trades genuinely in-scope also depends on Phase-1 profiling actually covering them (content/interview-kit work), not just on having their code in the taxonomy.
- **Rollback story:** every phase is additive behind the crosswalk. Phases 1/3 add data/columns; Phases 2/4 flip a consumer to the wider set; Phase 5 contracts the DB only after all reads move. Rollback at any point = revert that phase's PR; the legacy `role_*` ids stay valid because the crosswalk preserves them, so no shipped profile or job loses its classification. No shipped event payload is mutated (the ids inside `feed.shown` etc. are opaque taxonomy strings; a wider valid set does not re-version the payload).

---

## Alternatives considered

1. **Keep the ad-hoc gazetteer, widen it by hand as trades appear.** Rejected: it perpetuates the worker↔job id-space split (the two sides would still key on unrelated ad-hoc ids) and the adjacent-trade drop, and every new trade means bespoke crosswalk edits with no interop. It does not make cross-matching adjacent trades *possible* — only this shared standard does.
2. **O\*NET (US) as the standard.** Rejected in favour of NCO-2015: O\*NET is US-labour-market shaped (US titles, US skill/knowledge descriptors) and would need heavy re-mapping to Indian blue/grey-collar realities. **NCO-2015 is India's official occupation classification AND is ISCO-08-aligned**, so we get India-fit *and* international interoperability (an ISCO crosswalk) in one choice — the best of both.
3. **A bespoke BadaBhai taxonomy grown organically.** Rejected: it is what we effectively have today (the placeholder package), it has no external interop, no authoritative maintainer, and no crosswalk to any standard — exactly the position this ADR moves us out of.

---

## Open questions (surface, do not silently decide)

1. **Skill-taxonomy granularity.** NCO-2015/ISCO-08 classify *occupations*, not skills. The current `skill_*` / `mach_*` ids (controllers, GD&T, tool-offset, machine families) have no direct ISCO home. Decide whether to key skills to a separate standard (e.g. an ESCO-style skills pillar), keep the local skill vocabulary crosswalked to the standard occupations, or a hybrid. This does not block Phase 1 (occupation ids) but must be resolved before Phase 2 canonicalizes skills to the standard.
2. **Who owns the crosswalk?** The 7-role → NCO/ISCO and the 15 `trade_key` → NCO/ISCO crosswalks need a named owner (product + taxonomy) and a review cadence, since a wrong code silently mis-matches. Recommend the crosswalk live in `@badabhai/taxonomy` (versioned, reviewed) rather than scattered in `trade-content.ts` — the ADR-0015 follow-up already flagged moving the bridge into the taxonomy package "when a second consumer appears"; this is that second consumer.
3. **Adjacency handling for genuinely out-of-launch trades.** Even with a standard taxonomy, some trades stay out of Phase-1 launch scope (no interview kit / no resume content). Decide whether `unmatchable_reason` becomes "has a valid NCO code but out-of-launch-scope" (soft, re-engageable) vs the current "no canonical id at all," and how the worker experience differs. The standard code gives us a *place to put* an adjacent worker even before we fully support their trade.

---

## Scope boundary — what this ADR does and does NOT do

- **Does NOT block Track A** (`fix/ai-service-canonicalization-and-diagnostics`): that fix ships on the current 7-role gazetteer + the `map_rich_to_legacy` seam and the WS1 diagnostics; this ADR widens the id space *underneath* the same seam afterward.
- **Is the prerequisite** for (i) bringing adjacent trades genuinely in-scope for cross-matching, and (ii) wiring the **WS4 mapper backfill** (Phase 2) — both are impossible without a shared standard id space.
- **Does NOT** change the RANK core, the pseudonymizer, the LLM gate defaults, or the §3 stack; it does not open Phase-2 monetization/serving scope.

---

## Related
- ADR-0008 (`0008-litellm-to-direct-providers.md`) — LLMs assist, never decide (the mapper writes validated ids only)
- ADR-0011 / ADR-0015 (`0011-reach-feed-serving.md`, `0015-reach-feed-on-real-jobs.md`) — the RANK Role factor + the `trade_key`→`roleIds` crosswalk this ADR standardizes
- ADR-0022 (`0022-agency-supply-portal.md`) — the agency demand slice that reuses the same jobs + reach projection
- ADR-0027 (`0027-org-tenancy.md`) — org tenancy (orthogonal)
- `packages/taxonomy/src/index.ts` — the source of truth this ADR versions to a standard
- `apps/ai-service/app/profiling/signals.py`, `canonical_roles.py`, `profile_extractor.py` (`map_rich_to_legacy`) — the seam
- `apps/api/src/resume/trade-content.ts` (`roleIdsForTradeKey` / `taxonomy_role_ids`) — the ad-hoc crosswalk being standardized
- `packages/db/src/schema.ts` (`worker_profiles.canonical_*` ~L346, `jobs.trade_key` ~L855) — the versioned columns
- `packages/reach-engine` — the deterministic matcher that keys on the shared ids
- CLAUDE.md §2 invariants 1/2/3/4/8, §3 locked stack, §7 escalation
- The `migration` skill (`.claude/skills/`) — expand→migrate→contract discipline for Phase 5
- Tech-debt: **TD56** (pseudonymizer state-masking gap), **TD57** (transport retry-knob tuning, evidence-gated) — both logged 2026-07-08 with the ai-service canonicalization fix

*This ADR records the architecture decision to adopt a shared international-standard occupation taxonomy (2026-07-08). It authorizes a phased, additive, versioned rollout behind the existing rich→legacy mapper seam; no code, schema, or migration is produced here — implementation is handed to the engineer agents per phase.*
