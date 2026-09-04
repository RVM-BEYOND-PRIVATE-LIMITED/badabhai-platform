STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

NOTHING SURVIVES THIS CLOSURE. Every deliverable is either shipped, deleted by a signed
ruling, or carried by an E-phase. Checked adversarially, not assumed.

------------------------------------------------------------------------------
PHASE-ID: P4
INVARIANT: an active boost changes nothing on the company's candidate list — the same
rows in the same order, field for field — and that query reads no column from
`job_postings` at all.

STATUS: CLOSED 2026-09-04 — NOT BUILT. Every deliverable was deleted by ADR-0036.

EXPECTED ARTIFACTS: none. The owner's closure emptied this phase's artifact set, so
CHECK_RULES' first instruction cannot fire — it fails a phase whose expected artifacts
are ABSENT, and this sheet asks for none. Verify the CLOSURE instead. PASS when every
item is green; FAIL on any RED, naming the item. A RED means the closure is wrong.

Paste raw output for each.

1. The comparator carries no purchased or exposure term.
   grep -nE "boost|Boost|exposure|Exposure" packages/match-engine/src/rank.ts   (exits 1 today)
   Then print rank.ts:66-88 and list the keys in order.
   RED: any hit in rank.ts, or a seventh key beyond effectiveTier, skillMonths,
   industryMonths, lastWorkedAt, lastActiveAt, id.
   Do NOT widen this grep to the package: `boostSupplyFloor` (config.ts:60-61) and the
   feed card's `boosted` (types.ts:90) are legitimate and are not rank inputs.

2. The candidate-list SQL reads no job_postings column.
   awk '/async listCandidates/,/LIMIT /' apps/api/src/match/match-feed.repository.ts
   Anchor on the symbol, never a line window — the WORKER feed's legitimate
   `jp.boosted_until` sits 95 lines above in the same file (:160).
   RED: `job_postings` or `boosted_until` inside listCandidates.
   The `LEFT JOIN job_reach jr` at :251 is EXPECTED and display-only (:247-250) — it
   contributes nothing to the ORDER BY. Not a RED.

3. Nothing re-sorts between the repository and the response.
   grep -n "\.sort(\|boost" apps/api/src/match/match-candidates.service.ts apps/api/src/payer-portal/payer-reach.controller.ts   (exits 1 today)
   RED: any hit. The order is the SQL's (match-candidates.service.ts:58-61); a second
   sort would be a third implementation of one rule, invisible to items 1 and 2.

4. The fences executed.
   $env:RUN_DB_TESTS='1'; pnpm --filter @badabhai/api run test --no-file-parallelism boost-fences rank-parity posting-plans.service
   (bash: RUN_DB_TESTS=1 pnpm …)
   RED: an assertion failure in any of them, or boost-fences/rank-parity reporting
   "skipped" — .github/workflows/ci.yml:1429-1443 errors on exactly that.
   A connection error or "relation does not exist" is NOT a fence failure: Prakash may
   not have applied migrations yet. Record it under "What I could not verify". It is
   not PASS for this item and it is not RED.

5. The deleted terms have no referent.
   git grep -nE "functionSatisfied|function_satisfied|exposureBalance|exposure_balance|TENURE_MONTHS" -- '*.ts' '*.tsx' '*.sql' '*.dart' '*.py' '*.json'
   RED: any hit — someone started building a deleted deliverable.

6. job_reach still has five columns.
   packages/db/src/schema/match.ts:141-158; once migrations are applied, \d job_reach.
   RED: an engine_version, score or rank_position column on job_reach.

7. The governing ruling still governs.
   head -6 docs/decisions/0036-matching-algorithm-v1.md (Status must read Accepted);
   sed -n '774p' docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md (R7, must be blank).
   RED: ADR-0036 superseded, or R7 signed — R7 option (a) puts a reordering facet on the
   employer candidate list, which is this invariant's subject.
   INFORMATIONAL only, never RED: R4-d (ruled 21, 2026-09-04) settles a role count and does
   not bear on the rank key.

8. A closed phase produced no code.
   git diff --stat $(git merge-base HEAD origin/main) HEAD -- packages/match-engine apps/api/src/match/match-feed.repository.ts apps/api/src/match/match-candidates.service.ts apps/api/src/match/boost-fences.test.ts apps/api/src/match/rank-parity.test.ts
   The merge-base, never origin/main — origin/main moves and its commits are not this
   phase's. Scoped to files, not to apps/api/src/match, because PR #1387 lands
   matching-catalog.*.ts in that directory.
   RED: any non-empty output.
