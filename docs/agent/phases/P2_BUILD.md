STATUS: PARTLY CLOSED — the shared resolver, the A/B/C/D bands and the 22-role
fixtures are deleted by ADR-0036. What remains is buildable now: no matching_catalog,
no PR #1387, no migration, no unsigned ruling.

PHASE P2 — pin the tier derivation to one reference.

Rewritten 2026-09-04 against ADR-0036 and the code at HEAD.

DELETED BY ADR-0036:32 ("Nothing is hidden by a score, because at this layer there is
no score"): resolveMatchTier, tradeFactor, functionMultiplier, collarTierBand, the
0.85/0.30/0.15 bands, reasons[]. A capped product of coefficients is a score. Those
four identifiers have zero hits in any .ts or .dart file. Do not create them.
DELETED BY ADR-0036:34 (sort-never-block "retired deliberately, not by accident"):
"Never score zero. Never exclude the worker." reach.ts:93 — "`null` = no match at all,
which means the worker is not a candidate."
DELETED BY ADR-0036:23 ("retire the weighted engine"): the implementation shared with
reach-engine, and "delete the old tier logic from both engines". reach-engine is
scheduled for deletion. Do not touch it.
DELETED: the 22-role golden fixtures. R4-d(b) is now ruled — 21 — but 21 is the TAXONOMY
count, not the implemented one: role-registry.ts:39-45 declares five, all formEnabled. A
fixture set keyed to any hand-typed number goes stale on the next role; key it to the
registry.

THE TIER IS {1,2}: CHECK constraints at packages/db/src/schema/match.ts:173 and
packages/db/src/schema/job.ts:606. Never widen that domain.

WHAT IS WRONG. The tier rule is written five times. Two are pinned to each other by
rank-parity.test.ts (CI-gated, ci.yml:1416): packages/match-engine/src/rank.ts:37
effectiveTier and apps/api/src/match/match-feed.repository.ts:256. Three are pinned to
nothing:

  packages/match-engine/src/reach.ts:99               matchTierFor — the reference,
                                                      zero production callers
  apps/api/src/match/worker-skills.repository.ts:280  MIN(CASE ...) worker-side
  apps/api/src/match/worker-skills.repository.ts:360  MIN(CASE ...) posting-side
  packages/db/src/materialize-job-reach.ts:158        MIN(CASE ...) D5 runner

Those three write job_reach.match_tier. Nothing makes them agree with matchTierFor.

BUILD apps/api/src/match/tier-parity.test.ts, modelled on rank-parity.test.ts.
- Seed match_skill_ids explicitly; set reach_skill_ids to resolveReachSet of them. An
  arbitrary reach set tests whatever you chose to seed, not parity.
- NEVER seed a job_reach_widen grant. publish-reach.service.ts:158-160 makes a
  widened-in skill produce tier-2 rows matchTierFor rejects, BY DESIGN — out of scope.
- Drive BOTH materializeReachForPosting (:341) and reconcileReachForWorker (:256).
- Fixtures must include an exact-match worker (tier 1), a RELATED-ONLY worker (tier 2)
  — without one no tier mutation is observable — a worker holding both (E6, tier 1), a
  wants=false row, and a worker with no wanted skill in reach.
- Assert an exact row count and the exact worker-id set FIRST, then that every
  match_tier equals matchTierFor(wanted, match_skill_ids). An assertion over zero rows
  passes vacuously.
- Ids and integers only; workers rows take the enc:/hash: synthetic markers of
  rank-parity.test.ts:203-207.
- materialize-job-reach.ts exports nothing (private main() at :68), so pin :158
  textually against repository :360: normalize both (collapse whitespace, replace each
  ${...} with a placeholder), assert equality, and quote the raw pair — at HEAD they
  differ in indentation and in the interpolated name. Say in the test why it is a text
  pin and not a call.

ARM IT IN CI: add tier-parity at ci.yml:1416 and to the `for f in` loop at :1430, and
change 9 to 10 at :1448-1449. `match` is already in the alternation at :1431.

No migration. No matching_catalog. Add no NON-TEST file under packages/match-engine/src
— purity.test.ts:52 builds its list from nonTestSources, :55-65 pins it to eight names.

INVARIANT: on a posting whose reach_skill_ids is resolveReachSet(match_skill_ids) and
which carries no job_reach_widen grant, every match_tier written to job_reach equals
matchTierFor(the worker's wanted skills, match_skill_ids), and a worker matchTierFor
returns null for gets no row.
