PHASE-ID: P5
STATUS: BLOCKED ON RULING R7. The hot-tag half is deleted by ADR-0036. The expected artifact is
a HALT file, not code.

INVARIANT: no attribute enters the rank key, and no query parameter on
GET /payer/reach/jobs/:jobId/applicants changes WHICH workers the response contains.
This phase ships no code, so no test can guard it. Record that under "What I could not verify"
and do NOT fail on CHECK_RULES.md:31 for it, and do NOT write a test to satisfy it.
packages/reach-engine/src/no-skills-in-rank.test.ts is a weighted-engine rank lock, not this
invariant's guard — do not cite it as one.

EXPECTED ARTIFACTS: docs/qa/evidence/P5/HALT.md, and NO code change.
Absent code is NOT "phase not built" here. Shipped facet code IS the FAIL.

Do these checks and paste raw output with exit codes:
1. ls -l docs/qa/evidence/P5/HALT.md, then grep -n "R7\|774\|P0" it. A missing file, or one
   naming neither R7 nor the P0 FAIL, is a FAIL.
2. sed -n '794p' docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md. Dotted and blank means R7 is
   open and the HALT was correct. A signature there means this brief is stale: stop and report
   that, do not proceed.
3. git grep --untracked -in "facet" -- apps/api/src packages/reach-engine/src
   packages/match-engine/src packages/db/src apps/payer-web/src. Expected exit 1, no output.
   Any hit is a FAIL — a ruling settled by build. --untracked is required; files written this
   session are unstaged. Positive control: git grep -in "facet" -- docs/agent/phases/P5_BUILD.md
   must return hits at exit 0. If it does not, your grep is broken, not clean.
4. git grep --untracked -nw "facet" -- apps/payer-app/lib apps/worker-app/lib, and
   git grep --untracked -n "facet=" -- apps. Both expected exit 1. Word-bounded on purpose: the
   case-insensitive form matches "facets" in the Flutter API client and models, and
   surfaceTintColor in app_theme.dart.
5. git grep -n "@Query" -- apps/api/src/payer-portal/payer-reach.controller.ts. Expected exit 1;
   a hit is a FAIL. Control: the same grep over apps/api/src/payer-portal returns exactly two,
   payer-job-postings.controller.ts:107 and payer-unlocks.controller.ts:118.
6. git grep --untracked -n "HOT_TOP_RATIO\|hotTopRatio\|small_pool\|smallPool\|poolFloor" --
   apps/api packages. Expected exit 1. Keep the pathspec; unscoped it hits docs. Any hit is a
   FAIL — a deliverable ADR-0036:97 deleted, rebuilt anyway.
7. git diff 28560121 -- packages/reach-engine, and git status --porcelain --untracked-files=all
   -- packages/reach-engine. Both expected empty; a two-dot diff would miss uncommitted edits.
   Any change to ranking.ts:69 or :77, to reach-engine.test.ts:95-117, or to the formula mirror
   at reach-engine.property.test.ts:380-386 is a FAIL: BUILD_RULES.md:25 forbids weakening a test.

RECORD IN THE VERDICT, do not check: ADR-0036:86, "Boost never touches the company's candidate
list", is unresolved as money-specific or list-specific. Owner question. Do not settle it here.
