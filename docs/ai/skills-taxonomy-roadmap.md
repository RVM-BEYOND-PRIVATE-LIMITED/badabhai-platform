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
| **fork-B runner** | DB-side runner + ai embed endpoint | — | **MERGED** | TAX-3/4 | #219 |
| **FORK-B-1** | Request-path DB store (seam A) + reset flag + SR-1 runbook | **P1** | **MERGED + E2E-VERIFIED** | fork-B | #222 |
| TAX-5 | Data/AI — wedge aliases + floor calibration | **P1** | **CALIBRATED (floor 0.75)** · RVM gate open | TAX-4 | #225 |
| TAX-6 | Backend+AI — job side shares id space | P2 | **BUILT** (flag-gated; RANK locked; review PASS, M1-M3 fixed) | TAX-4 | #226 |
| TAX-7 | AI — growth loop (cluster unresolved) | P2 | **MERGED** (report-only; ratification flow = only activation path; `pytest -k growth`) | TAX-4 | #230 |
| TAX-8 | QA+AI — off-wedge résumé verify | P2 | **VERIFIED + LOCKED** (`pytest -k resume`; raw-phrase gap → Q14 — **decided + implemented 2026-07-16**: confirmed raw `skill_labels` render, pseudonymize-gated) | TAX-4 | #227 |
| TAX-9 | DB+AI — versioning + offline re-tag | P3 | **MERGED** (migration **0039 — owner apply pending**; dry-run default; `pytest -k retag`; review 8 findings fixed in-PR) | TAX-4/6 | #232 |

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

## FORK-B-1 — request-path store (seam A) + SR-1

`canonicalize_skill` now has a REAL store: `HttpSkillStore` (ai-service) → the api's
INTERNAL routes `POST /internal/skills/nearest-aliases` (owner-connection HNSW query) +
`POST /internal/skills/unresolved` (upsert + hash-only `skill.phrase_unresolved` event),
guarded by the SCOPED `SkillsInternalGuard` (`SKILLS_INTERNAL_TOKEN` — never the
all-routes secret). Fails OPEN to UNRESOLVED (an api outage degrades to
the raw-phrase status quo — canonicalization never blocks extraction); SG-2 stays
fail-closed. Extraction wiring canonicalizes **skills only** (WS4 role-backfill deferral
unchanged). Activation = vectors backfilled + `BACKEND_API_URL` +
`SKILLS_INTERNAL_TOKEN` on the ai-service + `SKILL_CANONICALIZE_ENABLED=true`
([SR-1 runbook](skill-embedding-staging-runbook.md); ADR-0030 addendum records seam A).
`--reset-embeddings` on the runner is the mixed-vector-space recovery.

**Executed + verified 2026-07-14 (SR-1 steps 1–8, local stack):** corpus seeded (33/76,
idempotent); **REAL backfill complete — 76/76 `gemini-embedding-001`@768 vectors,
₹0.0025, 0 blocked/errors** (`text-embedding-004` found RETIRED → 404 at the gated
first call — the staging-unverified gate did its job; model swapped + L2-normalized);
self-similarity 1.0000 / sibling gradient 0.85→0.65 / domain isolation confirmed at
rest. End-to-end: guarded route 401 tokenless; `0.9890 → skill_cnc_programming` via
the scoped token; extract loop live — below-floor miss upserted (`count` 1→2) +
hash-only `skill.phrase_unresolved` on the spine; ai-service made zero DB connections.
Floor probes for TAX-5: exact aliases score 0.99–1.0; paraphrases 0.67–0.74 (below
0.82 → honest UNRESOLVED); `kharad ka kaam` top-hit is WRONG (grinding, 0.61) → the
floor correctly refuses it — the TAX-5 vernacular alias (`kharad`→turning) is the cure.
Known limitation (empirical): extract queries the DEFAULT domain only — a 1.0 alias in
another domain is refused; per-label domain resolution is TAX-5/6.

## fork-B — DB-side runner (owner-chosen 2026-07-14)

The ai-service is **DB-free** and `skill_alias` is REVOKE'd from the Data-API role, so the real
vector read/write lives in a **`packages/db` runner (owner connection)** that calls the
ai-service embed over HTTP — **not** a psycopg client inside the ai-service (option A rejected).
Populates `skill_alias.embedding` (mock by default → runnable now with no spend; real is SG-4).
Prerequisite for TAX-5's *real* calibration and TAX-7's *real* clustering.

**Built (this PR):** `POST /embeddings/skill-alias` on the ai-service (batch ≤200, SG-2
pseudonymize-first per item, SG-4 mock-default, **per-request INR ceiling enforced IN the
endpoint** — `AI_MAX_CALL_COST_INR`, `budget_stopped` + per-item failure isolation, TD64
interim guard) + `packages/db/src/embed-skill-aliases.ts` (`pnpm db:embed:skills`,
prod-guarded, NULL-only resumable, blocked rows excluded per-run, response shape-validated,
progress-or-abort, halts on `budget_stopped`; `EMBED_BATCH_SIZE` env for small real batches).

**Live-activation chain (do not assume the flag alone activates anything):** a real
`SkillCanonicalStore` + enabling the `map_rich_to_legacy` call-site
(`apps/ai-service/app/main.py` WS4 owner-review TODO) + `SKILL_CANONICALIZE_ENABLED=true`
are ALL required before any label canonicalizes on the live path (TD65).

**Staging REAL-run runbook (§7):**
1. Requires `AI_ENABLE_REAL_CALLS=true` + `GEMINI_FLASH_API_KEY` + `AI_REAL_CALL_TASKS`
   **empty or containing `skill_embedding`** — the staging default pin
   `AI_REAL_CALL_TASKS=profile_extraction` makes the run silently MOCK and persists
   deterministic hash vectors.
2. Assert the runner report shows `mock=false` before accepting the run.
3. Recovery from a misconfigured run: `UPDATE skill_alias SET embedding = NULL` for the
   mock rows, then re-run (the batch is NULL-only resumable).
4. Precondition: wire the SpendLedger (TD64) — the endpoint's per-request ceiling bounds one
   request, not the day/user totals; ledger wiring is the staging-approved cap story.

## TAX-5 — Wedge aliases + floor calibration · **P1** · owner: ai + RVM

High match precision on the 7 launch roles + machine families, incl. vernacular shop-floor terms
the standards miss (kharad=lathe, chhilai=milling/finishing…), and a floor value justified by a
labeled set. **Two human/§7 gates:** (a) **RVM domain owner ratifies** the vernacular→standard
mappings (SG-3/TAX-0 human gate — I *propose*, human *approves*); (b) a *meaningful* floor
sweep needs **real semantic embeddings** (SG-4/§7) — on the mock embedder cosine is ≈0 for
different text and 1.0 for identical, so a mock sweep only validates plumbing (seeded terms
resolve, hard negatives stay UNRESOLVED), not the value. Buildable now: labeled wedge eval set,
`pytest -k wedge` harness, **proposed** `source=rvm` lang-tagged aliases, and sweep tooling;
**CALIBRATED 2026-07-14 on REAL vectors** (33-phrase labeled set,
`tests/wedge_eval/scores_2026_07_14.json`): **floor 0.82 → 0.75** — precision 1.000 in
BOTH scoring modes; recall is **0.800 ORACLE** (phrase scored in its correct domain) vs
**0.350 on the SHIPPED anchor-domain path** (every label queried in `cnc-machining`
until TAX-6 per-label domains — cite THIS number for launch, #225 review M1). Floor
clears all ceilings: labeled-negative 0.598, sibling-confusion 0.722, anchor-negative
0.7263; next TP 0.7815. Vernacular tier all ≤ 0.61 → the RVM
wedge aliases are REQUIRED and PROPOSED (22, `ratified: false`) — the human gate is the
[ratification packet](../registers/skill-vernacular-ratification-packet.md) (Q-A chhilai,
Q-B drawing padhna open). Re-sweep on any corpus/model change (`embed_wedge.py` →
`score-wedge.ts`); `pytest -k wedge` locks the conclusions offline. **Do NOT** seed
non-launch trades (TAX-7/8) or touch ranking. Files: `packages/taxonomy/src/wedge-aliases.*`,
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

**Built 2026-07-15:** `POST /growth/cluster` (`app/ai/growth.py` — PURE COMPUTE: deterministic
greedy leader clustering over caller-supplied vectors; guards `size >= min_cluster_size` OR
`total_count >= min_total_count`; band routing `[band_low=0.60, floor=0.75)` → alias-on-near-skill,
below → provisional; settings `skill_growth_*`) + `packages/db/src/growth-cluster.ts`
(`pnpm db:growth:cluster`, fork-B pattern: embeds NULL `unresolved_phrase.embedding` via the
existing embed endpoint — **refuses to persist MOCK vectors** unless `--allow-mock` (no provenance
column: a mixed space poisons centroid-vs-anchor; `--reset-embeddings` recovers a mix) — then
clusters per domain and writes the proposals packet to `docs/registers/skill-growth-proposals.md`
as paste-ready `wedge-aliases.ts` entries, `ratified: false`; `--apply` marks emitted members
`open → clustered`, default report-only). The runner re-verifies SG-3/SG-5 on the response (alias
ids ⊆ sent anchors; provisional carries NO id). **Adversarial-review hardening (9 confirmed
findings fixed in-PR):** phrase text is SANITIZED at packet render (control chars/backticks/length
— queue text is hostile free text; it cannot forge the ```ts paste-ready fence) and display
strings are length-capped at parse; the status machine is NOT a one-way door — `--reopen-clustered`
moves `clustered → open` (rejected/lost proposals regenerate deterministically) and the previous
packet is backed up (one slot) before overwrite; an embed gap (blocked / provider errors / budget
stop) no longer aborts the run — it continues PARTIAL, stamps the packet, and **refuses
`--apply`**; the report path is anchored to the module (not cwd); vectors are unit-normalized once
in the endpoint (~2-3x worst-case CPU cut; service-wide auth posture = TD67); Zod mirrors gained
`.finite()` and the Pydantic dim/finite check moved onto `GrowthPhrase`/`GrowthAnchor` themselves. **Two deliberate tightenings vs this spec:** (1) a provisional-skill
proposal mints **NO id** — `status='provisional'` id creation stays a HUMAN act in
`packages/taxonomy` (SG-5: ids are immutable, so wrong ids are forever; the automation ceiling
is the *proposal*, not the provisional row); (2) the "review surface" is the generated packet +
the existing ratification flow — no new ops event/table until the queue's volume earns one.
Locked by `pytest -k growth` (14 tests: shuffle-determinism, guards, band routing, SG-3 closed-set,
SG-5 no-id, 768/finite input hygiene, caps).

## TAX-8 — Off-wedge résumé verify · P2 · owner: qa + ai

**Verification/guard task, not a new builder.** Prove (and lock with tests) that UNRESOLVED /
out-of-launch-scope skills **degrade gracefully**: the résumé renders from the worker-confirmed
**raw phrases**; a canonical `skill_id` is attached as **metadata only** when available;
canonicalization **never blocks** résumé generation and never raises into it. `RESUME_SYSTEM_PROMPT`
untouched (AI-PERSONA-1 scope). **Do NOT** build a separate off-wedge generator or gate résumé on
canonicalization. Tests (`pytest -k resume`): launch-role (ids resolve), adjacent-trade
(out-of-scope id), novel skill (UNRESOLVED) — all produce a complete résumé; baseline snapshot
unchanged. OQ#3 (out-of-scope worker experience) is a product decision — flag, don't decide.

**Verified 2026-07-15 (`tests/test_resume_offwedge.py`):** launch-role ids render; off-wedge
degrades to "(to be confirmed)" and the résumé ALWAYS completes; the résumé path is
structurally independent of canonicalization (both entry points forced to raise → 200);
`RESUME_SYSTEM_PROMPT` pinned by sha256 tripwire (deliberate edits must touch the test).
HONEST FINDING (now closed): the spec's "renders from worker-confirmed raw phrases" was NOT
the behavior as verified — the résumé rendered closed-set ids or nothing; that gap was **Q14**.
**Q14 decided 2026-07-16 (owner) + implemented:** the confirmed raw labels now render via the
additive `DraftProfile.skill_labels` field (Zod + Pydantic), populated on the live
`/profile/extract` path from `WorkerProfileDraft.skills` (labels-only — deliberately NOT the
WS4-deferred `map_rich_to_legacy` role/id backfill) and **certified clean AT REST**: hygiene
clamp (≤20 labels, ≤80 chars, deduped) + pseudonymize certification at population, so a
blocked/masked/altered label never persists into `profiles.raw_profile` /
`generated_resumes.sourceProfileSnapshot` — the TS PDF + payer-disclosure renderers of that
snapshot therefore need no gate of their own. The résumé boundary **re-certifies (SG-2,
fail-closed, defense in depth)**: a label reaches the artifact and the LLM payload only when
`pseudonymize` certifies it clean (not blocked, nothing masked, text byte-identical); anything
else is silently dropped and the résumé still completes. `RESUME_SYSTEM_PROMPT` unchanged
(hash pin holds); all TAX-8 locks extended, none deleted; labels are display-only — never
matchable ids, never in events/`ai_jobs`/logs.

## TAX-9 — Versioning + offline re-tag discipline · P3 · owner: db + ai

Ids are immutable/never-reused; change is expressed by **version bump + status transition +
offline re-tag** of affected worker/job rows — **never on the live path** (SG-5/§8). Adds the
`active→deprecated` / `provisional→active` state machine + a `replaced_by` crosswalk on `skill`,
and an **offline retag job** (dry-run + apply, with a change report) that re-canonicalizes a
deprecated skill's rows to the replacement id. **Do NOT** live-retag or reuse ids. Documented in
the ADR-0030 rollout + the `migration` skill. Files: `packages/db/schema.ts` (extend TAX-1),
`apps/ai-service/app/retag.py`, ADR-0030, tests (`pytest -k retag`).

**Built 2026-07-15:** migration **0039** (additive `skill.replaced_by` + self-FK + CHECK
`replaced_by IS NULL OR status='deprecated'` — **owner apply pending**). **The state machine's
home is the corpus**: `SkillSeed.replacedBy` (validated — deprecated-only, known target, no
self-ref, no cycles) → `db:seed:skills` syncs it in a second pass (after every row exists, so
the self-FK always resolves; stale pointers cleared). Plan compute is fork-B-pure:
`POST /skills/retag-plan` (`app/ai/retag.py` — chain→terminal resolution with hop counts,
**cycles dropped fail-safe**, first-seen dedupe, untouched rows never listed; `pytest -k retag`,
12 tests) + Zod↔Pydantic `Retag*` mirrors. The runner `pnpm db:retag:skills` (dry-run DEFAULT →
`docs/registers/skill-retag-report.md`, ids/uuids only): scans `worker_profiles.skills` +
`job_postings.skill_ids` via jsonb `?|`, re-validates SG-5 on the response (after ⊆ originals ∪
terminals), excludes dead-end chains (terminal itself deprecated), and under `--apply` updates
rows with **optimistic concurrency** (`WHERE ids = before`; skewed rows skipped + reported) and
**moves the deprecated skills' aliases to their terminals** (new deterministic id + terminal's
domain_id, embedding copied — no re-embed; old row deleted) so future canonicalization assigns
the successor. `provisional→active` stays a corpus edit (seed upserts `status` since TAX-2);
`version` bumps stay corpus-author discipline.
