STATUS: CLOSED 2026-09-04 — every deliverable deleted by ADR-0036. Nothing to build.
Do not build from this file without reopening the phase.

PHASE P4 — feed ranking order, safe boost, exposure balance.

WHY IT CLOSES. ADR-0036 (Accepted 2026-07-31, unsuperseded) fixes the rank key, puts
boost in the worker's job feed, and fences it. All of that shipped. Nothing this brief
asked for survives it.

DELETED BY ADR-0036 §2 — the nine-term ranking order.
  :39-41 fixes the tuple at six terms; :61 — "Nothing else may enter the rank — not
  education, age, gender, caste, religion, RVM affiliation, attributes, or money."
  The shipped comparator carries the same six terms in the same order:
  packages/match-engine/src/rank.ts:66-88 — effectiveTier, skillMonths, industryMonths,
  lastWorkedAt, lastActiveAt, id. `functionSatisfied`, `exposureBalance` and
  `TENURE_MONTHS` have ZERO hits in any .ts/.tsx/.sql/.dart/.py/.json in this repo.
  `BoostTier` is real and is not a rank term: it is the domain of the purchased
  `posting_boosts.tier` column (packages/db/src/schema/payer.ts:396, 480, DB CHECK at
  492-495) plus a pricing schema at packages/pricing/src/types.ts:65.

DELETED BY ADR-0036 §7 — a boost term inside that rank.
  The comparator IS the company's candidate-list key: apps/api/src/match/rank-parity.test.ts:13-25
  pins rankKeyCompare to the ORDER BY in MatchFeedRepository.listCandidates
  (apps/api/src/match/match-feed.repository.ts:255-264) — "Edit one without the other and
  this fails." ADR-0036:86 — "Boost never touches the company's candidate list. Money
  orders jobs for workers; it never orders workers for money." BUILD_RULES:27 bars a
  money-influenced ranking input independently. Building it is a HALT.

DELETED — "this is the TD42 fix."
  ADR-0036:7 lists "TD42 (inert boost, retired here)". :83 puts boost in the WORKER'S JOB
  FEED as the LEADING sort key, and that shipped —
  apps/api/src/match/match-feed.repository.ts:160-162:
    ORDER BY (jp.boosted_until IS NOT NULL AND jp.boosted_until > now()) DESC,
             jp.published_at DESC NULLS LAST, jp.id ASC
  P4 asked to DEMOTE boost below a relevance bucket. That feed has no relevance bucket to
  demote it below, and a feed-order change is CEO sign-off plus its own ADR (:75).

DELETED — exposureBalance as a rank term.
  ADR-0036:61 closes the tuple. A new rank-key term requires a new engine_version, CEO
  sign-off and its own ADR (:75). That is the route if it is still wanted; not this phase.

DELETED BY ADR-0036 §5 — "Bump engine_version on job_reach."
  job_reach has FIVE columns and no engine_version: packages/db/src/schema/match.ts:141-158
  — job_posting_id, worker_id, match_tier, matched_skill_id, computed_at. engine_version
  is stamped per APPLICATION (:75) and a bump is CEO-gated, never a build-phase action.

DELETED — the property test over "all 22 roles."
  22 was never right: R4-d(b) is ruled 21 (owner, 2026-09-04), and 21 is the taxonomy count,
  while apps/api/src/profiling/roles/role-registry.ts:39-45 declares FIVE.
  The count is not why the test goes, though — see below.
  The rule that test would have guarded — boost never crosses a relevance bucket — no
  longer exists: the worker feed's ORDER BY has no relevance bucket, and the candidate
  list has no boost. No test asserts a bucket-crossing rule and none should. The three
  rules ADR-0036 §7 does state are each guarded — apps/api/src/match/boost-fences.test.ts:86
  and :100 (skill gate: visibility, then set identity), :119 with the structural guard
  :131 (candidate list), and the supply floor at
  apps/api/src/posting-plans/posting-plans.service.ts:548-583, covered by
  apps/api/src/posting-plans/posting-plans.service.test.ts:375-411.

INVARIANT (ALREADY TRUE at HEAD — a standing regression guard, not a build target):
an active boost changes nothing on the company's candidate list — the same rows in the
same order, field for field — and that query reads no column from `job_postings` at all.
Guarded by boost-fences (c) :119-129 and its structural twin :131-141.
