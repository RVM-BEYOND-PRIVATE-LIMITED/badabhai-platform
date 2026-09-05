STATUS: BLOCKED — THREE GATES, and each one HALTs a session run today.
  (1) ADR-0040 (docs/decisions/0040-candidate-search-filter-behaviour.md) is UNSIGNED. It
      carries owner ruling R-E1 and it settles worksheet ruling R7, whose signature slot at
      docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md:794 is still blank. Building this
      phase before either is signed IS a builder settling R1-R7, which
      docs/agent/BUILD_RULES.md:31 makes a full stop.
  (2) E4 MUST HAVE SHIPPED (owner ruling R-E3). See WHY E4 FIRST.
  (3) THE SUPPLY DOES NOT EXIST YET. See THE EMPTY-RESULT TRAP, immediately below —
      it is above the phase title on purpose.
A correct session today writes a HALT record naming all three and changes no code.

================================================================================
THE EMPTY-RESULT TRAP. READ THIS BEFORE ANYTHING ELSE, INCLUDING THE REST OF THE STATUS.

A CORRECT, WELL-BUILT E2 RETURNS ZERO ROWS TODAY. That is the world, not your code.

  (a) NO CLIENT REQUESTS `employer_sharing`. The worker app asks for exactly `profiling`,
      `resume_generation`, `voice_processing`
      (apps/worker-app/lib/features/consent/presentation/cubit/consent_cubit.dart:52-56).
      Every real worker therefore has the consent this phase gates on set to FALSE. E4 item 5
      is what changes that, and it is itself gated on DPDP notice copy that does not exist.
  (b) A COMPLETED TRADE FORM DERIVES NO `worker_skill` ROWS ON MAIN. The only caller of
      `rebuildQuietly` is the extraction processor
      (apps/api/src/profiles/profile-extraction.processor.ts:501), and the trade-form
      handover deliberately switches extraction OFF. PR #1425 changes that and is open.

**NEVER WIDEN THE `WHERE` CLAUSE TO MAKE RESULTS APPEAR.** Dropping the consent join to
"see some rows" in local testing is the exact edit that ships as a privacy breach, and while
you are making it, it will look and feel like debugging. There is no version of this that is
temporary: a search that returns a worker who never consented to be searched has already
disclosed him, and no later commit un-discloses him.

An empty result is the PASS condition, not a symptom. E2_CHECK item 3 makes that explicit:
with consent and `wants` in the `WHERE` clause an empty set PASSES, and before E4 and #1425
land a non-empty one — outside a seed that deliberately contains a consenting worker — FAILS.
================================================================================

PHASE E2 — POST /payer/candidates/search. A payer can find a worker.

WHAT EXISTS TODAY: NOTHING. This was measured by enumeration, not by keyword search — 320
route decorators across 69 controllers in apps/api/src, of which 18 controllers carry
`PayerAuthGuard`. No candidate search of any kind. The only route whose path contains
"search" is apps/api/src/jobs/jobs.controller.ts:47, which is worker-facing (`:48`) and
searches JOBS. payer-web has no `/candidates` page. Do not go looking for a half-built one.

WHY E4 FIRST, and it is not politeness. `wants` defaults TRUE
(packages/db/src/schema/match.ts:59), so this phase makes every derived worker visible to a
paying stranger by default. Until E4 ships, `setWants` throws
(apps/api/src/match/worker-skills.service.ts:157-165) and a worker's only exit is deleting
his account. Ship the exit before the door.

SOURCE THE POOL FROM `worker_skill`. NOT FROM `worker_profiles`.
  - The pool is `worker_skill` ⋈ `worker_industry_tenure` ⋈ `worker_consents` ⋈ `workers`.
    `worker_skill` carries the closed skill id, a DENORMALIZED `industry_id` (put there
    precisely so an industry filter needs no join —
    packages/db/src/schema/match.ts:46-48), bucketed months, and `wants`. The partial index
    `worker_skill_reach_idx ON (skill_id) WHERE wants` (`:79-81`) IS this query.
  - `ReachRepository.listSignalRows` (apps/api/src/reach/reach.repository.ts:81-101) is NOT
    the base to extend, for four reasons and any one is sufficient:
      (i)   it reads `worker_profiles`, the engine ADR-0036 retires;
      (ii)  its ABSENT `WHERE` is a load-bearing invariant, not an omission — its own
            docblock at `:43-48` says "there is NO relevance `WHERE` … so `count in ==
            count out` over the eligible pool stays structural, not policed". Adding a
            consent join or a LIMIT deletes that on a surface that still serves it, and
            PACE reads the same pool (apps/api/src/pace/pace.service.ts:193);
      (iii) its response leaks. `ApplicantRowDto.components[].reason`
            (apps/api/src/reach/reach.dto.ts:18-24, :35) carries exact numbers written by
            packages/reach-engine/src/scoring.ts:199, :201, :202 (exact years), :213 (exact
            expected-salary ratio) and :177-:181 (distance in km) — for a MASKED worker;
      (iv)  it has no LIMIT.
  - **DO NOT FIX (iii) IN THIS PHASE.** It is a real defect on a legacy route, it predates
    E2, and repairing it here is the "while I was here" edit docs/agent/BUILD_RULES.md:33-35
    forbids. It is already an open owner question. PARK it if it is not already parked; do
    not touch apps/api/src/reach/ or packages/reach-engine/ at all.

BUILD THESE SEVEN.

  1. `POST /payer/candidates/search`, under `PayerAuthGuard`, in a NEW module. POST rather
     than GET because the filter set is an unbounded list of skill ids — the same reason
     `POST /payer/match/reach-preview` is a POST that writes nothing
     (apps/api/src/match/match-skills.controller.ts:43). Register the controller in
     apps/api/src/common/guard-contract.test.ts, which imports every controller in apps/api
     and asserts its guards.
     NEST BOOT IS THE RISK HERE, not typecheck. One bad module edge has previously made the
     app fail to BOOT while typecheck, lint, build and unit tests all passed. There is a
     boot test beside every module (apps/api/src/match/match.module.boot.test.ts is the
     pattern); write one.

  2. THREE PREDICATES IN THE `WHERE` CLAUSE, ALWAYS, IN BOTH MODES. These are MEMBERSHIP,
     not filters, and R-E1's reorder-and-count must NOT be applied to them: a
     non-consenting worker does not rank lower, he is absent, and he is absent from the
     denominator too.
       - `employer_sharing` consent present and not revoked
         (packages/db/src/schema/worker.ts:125, :129). The unlock chokepoint gates on the
         same string (apps/api/src/unlocks/unlocks.service.ts:71) — reuse its meaning, do
         not re-derive it.
       - `wants = true` on the matched skill (packages/db/src/schema/match.ts:59).
       - `workers.deletion_scheduled_at IS NULL` (packages/db/src/schema/worker.ts:95) —
         ADR-0031 ruling (b), the payer-surface freeze.
     FAIL CLOSED. If the consent read errors, return no rows; never return unfiltered rows
     on an error path.

  3. R-E1 ORDERING, exactly as ADR-0040 Decision 5 writes it:
       ORDER BY filter_match DESC, <the ADR-0036 §2 rank key, unchanged, as the tie-break>
     `filter_match` is a BOOLEAN computed from the payer's own request. It is not a score.
     There is NO partial-match gradient and no "matched 3 of 4" — that is a weighted rank
     re-entering by the side door, and ADR-0036:61 plus docs/agent/BUILD_RULES.md:24 both
     forbid it. Two candidates who both match are ordered by the ADR-0036 tuple exactly as
     they are everywhere else.

  4. THE COUNT, AND IT IS THE CLAUSE MOST LIKELY TO BE DROPPED AS COSMETIC. Every response
     carries `matched` and `total` WHETHER OR NOT any row is returned. A strict search that
     matches nothing returns `{ matched: 0, total: 62, results: [] }` — never an empty
     envelope, never a 404, never a `total` the client has to fetch separately. ADR-0040
     Decision 3: a payer must never reach a state where the screen is empty and the reason
     is not on it. A design in which the count arrives in a second request can render the
     empty list first, which is the exact failure the ruling exists to prevent.

  5. STRICT IS OPT-IN AND EXPLICIT. `strict: true` on the request body. No config value, no
     remembered preference, no code path in which strict becomes the default. In strict mode
     `filter_match = 0` rows are excluded; that is the ONLY behavioural difference between
     the modes, and `total` still counts the whole eligible population.

  6. THE FILTER SET, and no more than this. Each one has a real column, a real writer and a
     real index (docs/decisions/E_CHAIN_DESIGN_2026-09.md §3.1): roles-sought / skills
     (`worker_skill.skill_id`), years of experience (`worker_skill.months_bucketed`, offered
     as BUCKETS — the column is bucketed to 6 months by config,
     packages/db/src/schema/match.ts:50-52, and a free-integer control would promise
     precision the data does not have), industry (`worker_skill.industry_id`), and years in
     the industry (`worker_industry_tenure.calendar_months`).
     **NO LOCATION FILTER.** `workers` has no city column; the only worker-side location is
     `worker_profiles.location_preference` (packages/db/src/schema/profile.ts:61), an
     unindexed JSONB written only by the extraction processor
     (apps/api/src/profiles/profile-extraction.processor.ts:402), and the question that
     fills it (`current_city`) is in `qp_universal` only — not in any of the five packs the
     shipping roles use. A trade-form worker has NO stored city by any path. Ship without it
     and SAY SO on the screen; do not render a control that filters on nothing.
     OWNER RULING 2026-09-05: ship without it, and do NOT edit the trade form question flow
     to get a city column — that boundary holds. What filling it would actually require is
     parked at PARKED.md P-018, including why "add a column and backfill it" is not the fix:
     the missing piece is the QUESTION, not the column. Read P-018 before proposing a
     location filter; do not re-derive it.
     NULL-SAFETY, in both modes and for every filter: unrecorded is NOT excluded. The
     precedent already ships on the worker feed and is to be copied rather than reinvented —
     apps/api/src/match/match-feed.repository.ts:152-155, whose stated reason is at
     `:150-152`.

  7. PAGINATE, AND MASK. A page limit clamped like every other list read
     (`clampLimit` / `OPS_LIST_CAP`, apps/api/src/common/pagination.ts). A row carries the
     OPAQUE `worker_id` and the frozen match inputs — no name, no phone, no photo, no
     employer. **Return the SAME `worker_id` the unlock chokepoint accepts**
     (`POST /payer/unlocks`, apps/api/src/payer-portal/payer-unlocks.controller.ts:66);
     minting a second, "more pseudonymous" id space would break the one flow this whole
     chain exists to serve, and would give the platform two identifiers for one worker.
     Rate-limit it with the existing per-payer hourly limiter, the same one the applicants
     route uses (apps/api/src/payer-portal/payer-reach.controller.ts:69-72). Do not invent a
     second limiter.

DO NOT EMIT `feed.shown`. The legacy applicants route emits one impression per ranked row;
the V1 path deliberately does not, and the reason applies here with more force — a payer
browsing a search result is not a feed impression, and recording it as one pollutes the
corpus the LEARN layer reads. The reasoning is written at
apps/api/src/payer-portal/payer-reach.controller.ts:57-62. The read is still audited: the
hourly cap counts it, and the money event is the unlock.

NEVER DO, each a full stop:
  - Touch apps/api/src/reach/ or packages/reach-engine/. Not to extend, not to fix, not to
    tidy.
  - Add a weight, a coefficient, or a blended score (docs/agent/BUILD_RULES.md:24;
    ADR-0036:61). `filter_match` is a boolean and must stay one.
  - Let money influence the order. No credit balance, plan, boost or capacity value may
    contribute to `filter_match` (docs/agent/BUILD_RULES.md:27; ADR-0036 §7 fence (c)).
  - Change the per-posting candidate list. `MatchCandidatesService.listForPosting` and the
    SQL at apps/api/src/match/match-feed.repository.ts:227-296 are a DIFFERENT surface and
    stay byte-identical; apps/api/src/match/rank-parity.test.ts pins that SQL to
    `rankKeyCompare` and both must keep agreeing.
  - Bump `engine_version`. ADR-0040 states why this change does not trigger one.
  - Run a migration. Write the file if you need one (docs/agent/BUILD_RULES.md:21).

DO NOT TOUCH: apps/ai-service, the profiling orchestrator, the chat service, the trade form
question flow, `pack_answers`, the worker conversational path. Also out of scope:
`MATCH_V1_ENABLED`, widening `MATCH_SKILLS` past eighteen, attribute filters (R7 territory —
ADR-0040 Decision 7 permits them, this phase does not build them), and RLS.

NOTHING HERE CAN BE PROVEN AGAINST REAL SUPPLY. The workers on the live database are
testers (owner ruling R-E4, 2026-09-05) and no worker data has been migrated from anywhere.
Every check for this phase runs against SEEDED LOCAL DATA and says so in its own text. A
result count from this phase is a fact about the seed.

INVARIANT: a worker who has not consented to `employer_sharing` never appears in a candidate
search result, in either mode, and is never counted in `matched` or in `total`.
