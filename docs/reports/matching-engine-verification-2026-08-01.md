# Matching Engine Verification Report — 2026-08-01

> Read-only audit of the Matching Algorithm V1 implementation (engine_version v1.0,
> ADR-0036) against the ratified spec. 28 checks across 7 groups; every FAIL/PARTIAL
> and every load-bearing PASS was independently re-verified by an adversarial second
> pass (13 re-verifications, 0 verdicts overturned). Nothing was modified.
> Audited at repo HEAD on main (b7316e3). Auditor: Claude (workflow of 20 read-only
> agents + first-hand spot reads).

---

## 0. Upstream blocker status (B1 / B2)

**B1 — worker feed job source: CONFIRMED BLOCKER (deployment state, not a code defect).**
In the default configuration real payer/ops `job_postings` cannot reach any worker:

- `GET /feed` branches on `isMatchV1Enabled` ([applications.service.ts:86](../../apps/api/src/applications/applications.service.ts#L86)). The default branch reads **only the legacy seed `jobs` table** ([applications.service.ts:95](../../apps/api/src/applications/applications.service.ts#L95) → [applications.repository.ts:140](../../apps/api/src/applications/applications.repository.ts#L140) `.from(jobs)`). There is no bridge, join, or ETL from `job_postings` into `jobs` (TD37), and no alternate worker-facing surface serves `job_postings` with the flag off.
- The V1 branch is **built and correct**: `FROM job_reach jr JOIN job_postings jp ON jp.id = jr.job_posting_id ... AND jp.status = 'open'` ([match-feed.repository.ts:140-143](../../apps/api/src/match/match-feed.repository.ts#L140-L143)).
- `MATCH_V1_ENABLED` defaults **false**, fail-safe ([server.ts:684](../../packages/config/src/server.ts#L684); `booleanFromString ... .default(false)` at [shared.ts:4-7](../../packages/config/src/shared.ts#L4-L7)), and the default is the *only* safe value today because the migration train has not been applied: the repo's own runbooks state "Nothing has been applied to any shared, staging, or production database" ([matching-v1-migration-runbook.md:974-976](../ops/matching-v1-migration-runbook.md)) and "P1 (migration train) has not started" ([production-release-runbook.md:76](../ops/production-release-runbook.md)). Flipping the flag today would serve an **empty** feed (`job_reach` unpopulated).

**Bottom line for B1:** the matching engine is currently **inert in production** by deliberate launch-gating. The release blocker is executing the runbook (migrations 0052–0059 → data steps D1–D6 → `db:verify:match-v1` → deploy → flip), not fixing engine code.

**B2 — skill-canonicalization flag: NOT A BLOCKER (the audit brief's premise is stale).**
`SKILL_CANONICALIZE_ENABLED` does exist and defaults false ([ai-service config.py:139](../../apps/ai-service/app/config.py#L139)), and with it off `job_postings.skill_ids` is indeed empty on real postings. **But `skill_ids` is not the match input.** It is ADR-0030 descriptive tagging, "explicitly NOT a match input" ([job-postings.dto.ts:134-137](../../apps/api/src/job-postings/job-postings.dto.ts#L134-L137)). Visibility runs on **`match_skill_ids`** — closed-set `mskill_*` ids picked in the payer-web posting form ([payer-api.ts:1108](../../apps/payer-web/src/lib/payer-api.ts#L1108)), Zod-validated server-side, materialized into `job_reach` with no LLM and no flag ([job-postings.service.ts:387](../../apps/api/src/job-postings/job-postings.service.ts#L387)). The worker side (`worker_skill` derivation) is also un-gated: it runs on every extraction via the local deterministic extractor + taxonomy bridge maps ([profile-extraction.processor.ts:171](../../apps/api/src/profiles/profile-extraction.processor.ts#L171) "NOT gated on MATCH_V1_ENABLED, deliberately"; [derive.ts:56-64](../../packages/match-engine/src/derive.ts#L56-L64)); the vector pass only *appends* extra ids when the flag is on.
Residual (by design): a posting published with empty `match_skill_ids` reaches nobody — D3 leaves those on an ops worklist and the E13 zero-reach alert fires.

---

## 1. Findings summary table

| # | Check | Verdict | Severity | File:line | Note |
|---|-------|---------|----------|-----------|------|
| A1 | Feed reads real `job_postings`? | **FAIL** | CRITICAL | applications.service.ts:86,95; match-feed.repository.ts:140 | Default = legacy `jobs` only; V1 path built+gated; migration train unapplied |
| A2 | Canonicalization flag / `skill_ids` empty | **PASS** | MEDIUM | config.py:139; job-postings.dto.ts:135-151 | Flag off ⇒ `skill_ids` empty, but match runs on `match_skill_ids` (unaffected) |
| A3 | `MATCH_V1_ENABLED` wiring + flip readiness | **PARTIAL** | HIGH | server.ts:684,1184; runbook :829-848 | Code gate correct/fail-safe; runbook preconditions (0052–0059 + D1–D6) unmet |
| B4 | 7 tables + required columns | **PASS** | INFO | schema.ts:2278-2659; migrations 0052-0057 | Name deltas: `match_skill_ids`, `months_bucketed`, `calendar_months` |
| B5 | `applications` stores raw inputs, no score | **PASS** | INFO | 0056:63-68; match-apply.service.ts:108-118 | Exactly the 5 raw inputs; legacy `rank` col = pre-V1 display position, never read by rank |
| B6 | `skill_related` symmetric | **PASS** | LOW | schema.ts:2399; match-taxonomy.ts:222-224; verify-match-v1.ts:95-101 | Dual-row seeder + verify script; API path uses construction-symmetric taxonomy |
| B-idx | Indexes cover the two reads | **PARTIAL** | LOW | 0055:52; 0056:72; match-feed.repository.ts:255-264 | Rank index sorts raw columns; floor CASE forces a (cheap) in-memory sort node |
| C7 | Invariant A test, randomized | **PASS** | INFO | rank.invariants.test.ts:19-119 | Seeded PRNG, 500× below-floor + 500× above-floor + exact 36 boundary |
| C8 | Invariant B test, randomized | **PASS** | INFO | rank.invariants.test.ts:122-162 | 1000× adversarial (max industry advantage), same-effective-tier asserted |
| C9 | Invariant tests wired into CI | **PARTIAL** | HIGH | ci.yml:97,325-332; rank-parity.test.ts:49,108 | Unit invariants ARE release-gated (branch protection verified live); **SQL↔TS parity test skips in CI** (`RUN_DB_TESTS` set nowhere) |
| C-key | Rank key exact + cross-impl parity | **PASS** | LOW | rank.ts:66-89; match-feed.repository.ts:255-264 | Slot 5: TS names it `lastActiveAt` but populates from `application.created_at` = ADR key; naming drift flagged |
| D-E1 | Untick removes tier-2 visibility | **PASS** | INFO | worked-examples.test.ts:183-217; reach.ts:65-71 | All three spec rows asserted |
| D-E3 | 6mo exact vs 10yr related | **PASS** | LOW | rank.ts:37-46; worked-examples.test.ts:259-345 | Tier-with-floor@36 shipped; see §3 |
| D-E5 | Multi-skill: MAX across posted | **PASS** | INFO | rank.ts:131-140; worked-examples.test.ts:360-361 | `toBe(36)` + `not.toBe(48)`; no competing SQL aggregation |
| D-E6 | Exact+related: MIN tier, exact months | **PASS** | INFO | reach.ts:107; rank.ts:119-121; materialize-job-reach.ts:158-160 | Tier-1 eligibility = posted set only; matched_skill_id sorts posted-first |
| D-E7 | Skill sums across industries; industry per-industry | **PASS** | INFO | rank.ts:131-135; tenure.ts:68-106; worked-examples.test.ts:398-418 | 42/24 pinned both layers |
| D-E8 | Clamp industry ≥ skill | **PARTIAL** | MEDIUM | tenure.ts:90-94; match-apply.service.ts:110-113 | Write clamp per-industry (correct); apply clamp uses cross-industry sum — **latent** E7 conflict, unrepresentable today (unique (worker,skill)) |
| D-E9 | Interval-merge, not sum | **PASS** | INFO | tenure.ts:161-217; tenure.test.ts:60-82 | Identical-window fixture asserts 24 not 48 |
| D-E11 | Ties deterministic, total order | **PASS** | LOW | rank.ts:85-88; both ORDER BYs end in unique id | Repeat-read stability tested (DB-level test skip-gated, see C9) |
| D-E16 | Freeze-at-apply, no reorder after edit | **PARTIAL** | MEDIUM | match-apply.service.ts:108-118,175-184; match-feed.repository.ts:243-264 | Design correct (single-statement CASE, read = snapshot only); **no Postgres-level ON CONFLICT test, no end-to-end edit→re-read test; test comment points at a file that doesn't own it** |
| E10 | Everything computed on write | **PASS** | INFO | worker-skills.service.ts:79-111; worker-skills.repository.ts:290-315 | Profile write rebuilds skills+tenure; publish = one INSERT..SELECT with `MIN(CASE...)`; edit/unpause/widen re-materialize; worker changes reconcile onto open postings |
| E11c | Reads are pure ORDER BY | **PASS** | LOW | match-feed.repository.ts:160-163,255-264; purity.test.ts:79-113 | Only app-layer step is the spec's own E14 interleave (deterministic permutation, config-driven) |
| F12 | Config externalized (9 values) | **PASS** | INFO | config.ts:34-62; 0057; match-config.service.ts:112-122 | Fail-closed to typed defaults; no literal 36/6 in the live path; `applicant_quota` declared-but-dormant (off by design) |
| F13 | `engine_version` stamped per row | **PASS** | LOW | match-apply.service.ts:117,157-164 | From config, not SQL-defaulted; NULL only on skips + legacy rows (both spec-consistent) |
| G14 | LLM can never assign a skill_id | **PASS** | INFO | profile_extractor.py:241-269; canonicalize.py:90; match.dto.ts:14 | Three independent rejection layers (id-shape drop, closed vector set, closed-set DTO/bridge + FK) |
| G15 | Boost fences (3) + TD42 docs | **PARTIAL** | MEDIUM | boost-fences.test.ts; posting-plans.service.ts:304,548-584 | All 3 fences hold in code; **fence suite skips in CI; TD42 register/overview docs stale vs ADR-0036** |
| G16 | Ops widen: widen-only, audited, expiring | **PARTIAL** | MEDIUM | publish-reach.service.ts:131-187 | Widen-only + audited + evented PASS; **expiry NOT implemented** (disclosed); PACE not yet decommissioned in code |
| G17 | Attributes never rank; purity scanner | **PASS** | LOW | purity.test.ts:25-139; derive.ts:62-64 | Structural exclusion (worker_skill can only hold mskill ids); no DB-level kind CHECK (noted) |

---

## 2. Critical issues (must fix before relying on this engine)

1. **The engine is inert until the release train runs (A1/A3, CRITICAL).** Migrations 0052–0059 + data steps D1–D6 are authored but unapplied to any shared DB; `MATCH_V1_ENABLED` is off everywhere. Real payer postings reach zero workers today. This is sequencing, not code — but it gates every other verdict in this report from "verified in tests" to "verified in production". Note migration 0056 is the flagged **one-way door** (once the first V1 application writes `job_id NULL`, the rollback path closes).

2. **The SQL↔TS rank parity pin never runs in CI (C9, HIGH).** The rank tuple exists in two implementations by necessity (`rankKeyCompare` and the `listCandidates` ORDER BY), pinned to each other by [rank-parity.test.ts:134](../../apps/api/src/match/rank-parity.test.ts#L134) — but that suite is `describe.skipIf(!RUN_DB_TESTS)` and `RUN_DB_TESTS` appears **nowhere** under `.github/workflows/` (grep-verified; disclosed as TD122). The same gate skips `boost-fences.test.ts` and the DB half of `match-feed.repository.test.ts`. An edit to either rank implementation merges green with the drift-catcher never having run. The unit invariants (A-with-floor, B) **are** release-gated — `ci-required` + live-verified branch protection — so the spec's "automated tests, not manual QA" bar is met at the engine layer but not at the SQL layer. Cheap fix: the CI e2e job already provisions migrated pgvector Postgres; set `RUN_DB_TESTS=1` there and run the three gated suites.

3. **E16 freeze has no database-level proof (D-E16, MEDIUM).** The freeze is correct by construction (snapshot columns overwritten only on a skip→apply flip via a single-statement `CASE`; the candidate list ORDER BY reads only frozen columns, fenced by a no-live-column test). But no test exercises the `ON CONFLICT` freeze against real Postgres, no test does apply → profile edit → re-read → assert identical order, and the comment at [match-apply.service.test.ts:367-368](../../apps/api/src/match/match-apply.service.test.ts#L367-L368) claims rank-parity.test.ts owns that proof — it does not (it seeds by direct INSERT and never calls `upsertDecision`).

4. **Latent E7/E8 conflict on the apply path (D-E8, MEDIUM, dormant).** The apply-time belt-and-braces clamp `industryMonths: Math.max(industryMonths, skillMonths)` ([match-apply.service.ts:113](../../apps/api/src/match/match-apply.service.ts#L113)) compares against the **cross-industry** skill sum, which the spec's own per-industry clamp rule forbids (tenure.ts:29-31). In the E7 shape (fitter: 24mo MFG + 18mo elsewhere) it would snapshot `industry_months=42` instead of 24. Unrepresentable today — `worker_skill` has a unique (worker_id, skill_id) index and industry is denormalized from the skill — but the schema pre-provisions per-stint columns, so this trips the moment multi-industry same-skill rows land.

5. **TD42 doc drift (G15, MEDIUM).** ADR-0036 §7 deliberately retired TD42: behind `MATCH_V1_ENABLED`, boost **does** lift a card in the worker feed (`ORDER BY boosted DESC, published_at DESC, id ASC`), fenced three ways. The code confirms the design and the fences hold (candidate list provably boost-blind; supply floor checked before any payment event). But [tech-debt-register.md:53](../registers/tech-debt-register.md) still carries TD42 as "Open… the booster reorders nothing today", and `docs/architecture/overview.md:61` + `docs/sprint-plans/phase-1-worker-profiling.md:98` still say boost ranking is deferred. Per the audit brief's rule this is flagged loudly: **boost-affects-feed is by design under ADR-0036, not a rogue wiring — the failure is that three docs never caught up.** Two disclosed fence caveats: the supply gate fails **open** on an unreadable reach count and is disabled when the config floor ≤ 0.

6. **Ops widen has no expiry (G16, MEDIUM).** Widen-only (structurally — the DTO cannot express removal) and audited (event `job_posting.reach_widened`, InternalServiceGuard) both PASS, but the spec's "expiring" clause is not implemented — a widen is permanent until re-materialization, self-disclosed at [publish-reach.service.ts:131-139](../../apps/api/src/match/publish-reach.service.ts#L131-L139). Also: ADR-0036 says PACE retires with the weighted engine, flagged for owner acknowledgement — `PaceModule` is still registered in `app.module.ts`.

---

## 3. E3 ruling — what's actually shipped

**Tier-with-floor at 36 months** (not strict tier dominance). Owner ruling 2026-07-31, recorded in ADR-0036 §2 ("Part 9 ruling #1, option b") and implemented identically in both rank implementations:

```ts
// packages/match-engine/src/rank.ts:37-46
export function effectiveTier(matchTier, skillMonths, tierFloorMonths) {
  if (matchTier <= 1) return 1;
  ...
  return months >= floorMonths ? 1 : 2;   // inclusive at 36
}
```

```sql
-- apps/api/src/match/match-feed.repository.ts:255-259 (candidate list ORDER BY)
CASE WHEN a.match_tier > 1 AND COALESCE(a.skill_months, 0) >= :tierFloorMonths
     THEN 1 ELSE COALESCE(a.match_tier, 2) END ASC, ...
```

- `tier_floor_months` is **config** (`match_config`, Zod default 36 at [config.ts:57](../../packages/match-engine/src/config.ts#L57)), not a constant; no literal 36 exists in the live path.
- Raw `match_tier` is never overwritten, so the UI still badges a floor-promoted candidate as a related match (E18).
- Both directions are tested: 120mo-related beats 6mo-exact; 24/30mo-related stays tier 2; the boundary at exactly 36 is pinned inclusive; the **rejected** strict-tier behaviour is measured (floor=MAX_SAFE_INTEGER test), plus 1000 seeded randomized property cases.
- Documentation trail: the ruling is explained in a code comment (rank.ts:23-27 "OWNER RULING 2026-07-31 — TIER WITH FLOOR…") and in ADR-0036. Nit (LOW): the literal string "ADR-0036" appears nowhere inside `packages/match-engine` — the engine's pointer is "spec Part 9 + date"; the ADR number is only cited in the apps/api match layer. Findable, one hop longer than ideal.

**Related divergence worth recording:** the spec draft's rank slot 5 is `last_active_at`; ADR-0036 ratified `created_at`. The shipped code does both at once: the TS comparator field is *named* `lastActiveAt` but is *populated* from `application.created_at` ([types.ts:70-71](../../packages/match-engine/src/types.ts#L70-L71), [match-candidates.service.ts:114](../../apps/api/src/match/match-candidates.service.ts#L114)), and the SQL sorts `a.created_at`. Behaviorally = the ADR key. Risk: if a future "last seen in app" signal is ever wired into `lastActiveAt` (which the type comment invites), the TS comparator silently diverges from the SQL — and the parity test that would catch it currently skips in CI (issue #2 above).

---

## 4. Gaps vs missing tests

| Gap | Where | Status |
|-----|-------|--------|
| SQL↔TS rank parity suite skips in CI | rank-parity.test.ts:49,108 (`RUN_DB_TESTS`) | Disclosed (TD122), not enforced |
| Boost fence suite skips in CI | boost-fences.test.ts:39 | Same gate |
| DB half of feed-repository suite skips in CI | match-feed.repository.test.ts | Same gate |
| No Postgres test of the ON CONFLICT snapshot freeze | match-apply.service.test.ts:367 points at the wrong owner | Missing |
| No end-to-end apply → edit profile → re-read → same-order test (E16 as-stated) | — | Missing (mocked unit test only) |
| No test pinning apply-path `industryMonths` clamp against the E7 cross-industry shape | match-apply.service.test.ts:130-138 asserts skillMonths only | Missing (shape currently unrepresentable) |
| Ops-widen expiry (spec: "audited/**expiring**") | publish-reach.service.ts:131-139 | Not implemented, disclosed |
| `applicant_quota` consumer | config only | Dormant by design (off at launch) |
| Doc drift: TD42 register row, architecture overview, phase-1 sprint plan | tech-debt-register.md:53; overview.md:61 | Stale vs ADR-0036 |
| Stale comments: "straight out of the index" (predates floor CASE); server.ts "0052–0058" (train is –0059) | schema.ts:1293; match-feed.repository.ts:71; match-candidates.service.ts:58; server.ts:678 | Cosmetic |

Worked-example coverage is otherwise complete: E1, E3 (both directions + boundary), E5, E6 (including the subtle exact-months half), E7, E9 (identical-window fixture), E11 (repeat-read stability) all have tests asserting the documented outcome, with the producing code traced — not just test names matched.

---

## 5. Everything that passed

- **Schema (B4/B5/B6):** all 7 tables present in schema.ts + migrations 0052–0057 with the required columns (naming deltas documented: posted skills = `match_skill_ids` jsonb; `months_bucketed`; `calendar_months`). `applications` stores exactly the five **raw** rank inputs + `engine_version` — **no precomputed score exists anywhere** (the pre-V1 `rank` column is an ADR-0009 display-position capture, never read by V1 ranking). `skill_related` symmetry is enforced by dual-row seeder + live verify script, and the API publish path uses the construction-symmetric taxonomy adjacency, so it cannot even observe an asymmetric DB row.
- **Invariants (C7/C8):** genuinely property-based — seeded PRNG, 500+500 randomized cases for A-with-floor (below/above floor), 1000 adversarial cases for B (weaker-skill row handed maximal advantage on every later key), boundary pinned inclusive at 36, config-floor-240 re-tighten case. Running in **required** CI (turbo → vitest, `ci-required` aggregator, branch protection re-verified live via the GitHub API).
- **Write-time computation (E10):** profile write derives `worker_skill` + rebuilds interval-merged tenure in one transaction; publish is one `INSERT..SELECT` with `MIN(CASE WHEN skill_id = ANY(posted) THEN 1 ELSE 2 END)` best-tier-wins and a matched_skill_id aggregation that cannot disagree with the tier; edit/unpause/ops-widen re-materialize with stale-row deletion in the same transaction; worker profile changes reconcile onto all open/paused postings; closed postings' history untouched.
- **Read paths (E11c):** both queries are pure indexed sorts ending in a unique column (total order). The only app-layer step is the spec's own E14 max-2-per-company interleave — a deterministic, never-drops-a-row permutation driven by config. The purity scanner statically bans clocks/randomness/embeddings/weight identifiers and pins exactly one exported comparator.
- **Config (F12/F13):** all nine values in `match_config` (pricing_catalog pattern), Zod fail-closed to typed defaults, consumed at runtime (floor and bucket traced into live call sites; zero hardcoded 36/6). `engine_version` stamped from config on every V1 applied row.
- **Guardrails (G14/G17):** three independent layers stop a model-emitted skill id (id-shape drop before draft merge; vector layer only returns closed-set ids; DTO regex + closed-set check + FK on the API side) — no bypass path found. Attributes are structurally excluded from reach/rank. Boost's three fences hold in code: gate-fenced (boost lives only in ORDER BY over an already-gated join), candidate-list-blind (byte-identical with/without boost + structural no-boost-column scan), supply-floor-checked before any payment event.
- **Privacy posture of the new surface:** the feed projection deliberately omits `org_label` (the one open ADR-0036 privacy question) and selects only an opaque payer key.

---

## 6. Recommended next actions, in priority order

1. **Execute the Matching V1 release train** per [matching-v1-migration-runbook.md](../ops/matching-v1-migration-runbook.md): apply 0052–0059 (0056 is the one-way door — verify the rollback precondition first), run D1–D6, `db:verify:match-v1` must exit 0, deploy, then flip `MATCH_V1_ENABLED` last. **Owner-gated** (production data + destructive-adjacent; CLAUDE.md §7). Until then every green verdict above is verified-in-tests, not verified-live.
2. **Arm the DB-gated suites in CI:** set `RUN_DB_TESTS=1` in the e2e job (it already provisions migrated pgvector Postgres) and run `rank-parity`, `boost-fences`, and the feed-repository DB tests. This turns the SQL↔TS rank pin and the three boost fences from disclosed gaps into release gates at near-zero cost.
3. **Close the E16 evidence gap:** add a Postgres-level `upsertDecision` ON CONFLICT test (skip→apply flips, applied→applied frozen) and an end-to-end apply → profile edit → re-read → identical-order test; fix the misleading comment at match-apply.service.test.ts:367.
4. **Resolve the D-E8 latent conflict** before per-stint/multi-industry rows become representable: clamp at apply against *per-industry* skill months (or add a fenced test documenting the launch-only single-industry assumption).
5. **Docs sweep:** retire/annotate TD42 in the tech-debt register, update architecture overview + phase-1 sprint plan boost lines, fix the four stale "straight out of the index" / "0052–0058" comments, and consider adding an explicit `ADR-0036` cite inside `packages/match-engine`.
6. **Owner decisions to schedule:** ops-widen expiry implementation (Policy 27's third clause), PACE decommission acknowledgement (ADR-0036 consequence), and the `org_label`-on-worker-card security sign-off before the feed ships.
7. **Later, if applicant volume grows:** an expression index matching the effective-tier CASE (or write-time `effective_tier`) to restore pure index-order candidate reads; today the in-memory sort node is cheap and correctness is unaffected.
