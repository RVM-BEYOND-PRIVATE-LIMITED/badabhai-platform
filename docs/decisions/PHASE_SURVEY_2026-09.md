# Phase survey — P2 to P12 against current main

**For:** Prakash (owner)
**Date:** 2026-09-03
**SHA:** `deed1a0be0abca095f5d82b8184cc9f59882f6b0` — `origin/main` and `HEAD` agreed, delta 0/0, tree clean
**Scope:** a SURVEY. No phase brief applied. No code, schema, migration or commit was written.

## Owner rulings on this survey — Prakash, 2026-09-03

Recorded here because they change what the briefs say, and a survey that outlives them
becomes the next wrong document.

| # | Ruling |
|---|---|
| ① | **ADR-0036 IS IN FORCE.** Nothing supersedes it, and Accepted 2026-07-31 postdates everything the briefs were written from. **Where a brief conflicts with ADR-0036, ADR-0036 wins and the brief is wrong. Retired concepts are not preserved in any form.** |
| ② | **The external spec is NOT an authority.** `BUILD_RULES.md` is right to list only what is in-repo. A brief may not cite a document that is not in this repository. |
| ③ | **Prakash applies migrations** between the build and check sessions — not Divyanshu. Agents still never execute DDL. This closes the P1/P3/P8 uncheckability gap. |
| ④ | **`BADABHAI-CODEBASE-INTELLIGENCE-REPORT.md` is not an authority.** A snapshot with no SHA that invents `job_reach` columns and constants. Every reference struck from every brief; the file keeps a NOT-AN-AUTHORITY header. |

**Consequence for the verdicts below.** The per-phase recommendations were written before
these rulings. Under ① several phases lose deliverables outright rather than being merely
"blocked": P5's hot tag, P7's PACE and push floor, and P2's A/B/C/D bands and multiplicative
`tradeFactor` are all retired concepts and are deleted, not deferred. The rewritten briefs
carry the current instruction; **this document is the evidence, not the plan.**

## For the next session: no rewritten invariant has been demonstrated to fail

**Owner instruction, 2026-09-04.** Every invariant in the rewritten briefs was derived by
reading shipped code. **None has been observed going red.** No test was run, no database was
touched and no service was started in either the survey or the rewrite, so each invariant is
*shippable*, not *demonstrated* — and a check item nobody has watched fail is exactly the
class of defect this survey found six of.

**Therefore: treat the FIRST PASS on any phase as weaker evidence than a later one.** A first
green run is consistent with a working gate and with a gate that cannot go red at all. The
rewritten CHECKs are built to tell those apart — several now ask the checker to mutate one
line and confirm the gate turns red before accepting a green run as evidence. Run that step;
it is the only part that distinguishes the two.

The first check session under the new migration rule (Prakash applies, between the sessions)
is what converts these invariants from reasoned to demonstrated.

**P1 was never surveyed, and its build is unchecked.** `P1_BUILD.md` / `P1_CHECK.md` were
outside this survey's scope, and P1's brief is deliberately NOT rewritten — rewriting a brief
for code that is already written is backwards. What P1 needs is R1–R4 signed, then a merge,
then a check session run against `p1-matching-catalog`. Nobody has run P1_CHECK's four
invalid-catalog rejections, its auth refusal, or its single-active-row constraint.

---

## Why this document exists

PX was briefed as a build. It was already implemented, and its brief carried three factual
errors and pointed at a corpus that does not exist. This survey asks, for each remaining
phase, whether the same is true — before the phase is written rather than after.

**It is.** Eleven briefs were surveyed. **Ten contain at least one statement about this
codebase that is false**, and 67 distinct brief errors were found. Every one is cited by file
and line. Nothing here was fixed, and no brief was corrected.

### Method, and its limit

Eleven independent phase surveys plus six targeted probes, each attacked afterwards by
adversarial refuters on an absence lens (search harder, other names), a presence lens (open
the cited file, is it wired), and a brief-might-be-right lens. Findings that did not survive
were dropped; several are recorded below as *withdrawn* because the withdrawal is itself the
finding. A completeness critic then reconciled the eleven against each other.

**The limit, stated plainly: no test was run, no database was touched, no service was
started.** Every claim below is static reading of files at this SHA. Every INVARIANT's
runtime enforceability is therefore unverified.

---

## The five things you asked me to check

| # | Your question | Answer |
|---|---|---|
| 1 | Does `role-form-descriptor.ts` already serve step and field definitions, making P8/P10 "extend it"? | **No.** It serves none of the eight things P8 asks for. But a step/field server *does* exist elsewhere. |
| 2 | Is the P4 boost fix (TD42) really not implemented? | **It is implemented and TD42 is retired** — by signed ADR-0036 §7, fenced by a CI-gated suite. |
| 3 | Do the contact caps already exist? | **Yes**, at the unlock chokepoint, before payment — but at different numbers and windows than the brief names. |
| 4 | Does the push floor at 40/100 exist? | **Yes**, at `reach-engine/src/ranking.ts:11` as `0.4`. Not in the push processor, and retired by the 2026-07-31 ruling. |
| 5 | Do two divergent tier implementations still exist? | **Not in the two packages the brief names.** `reach-engine` has zero occurrences of "tier". Five tier sites exist elsewhere, three of them SQL. |

Four of five are a brief error. Three point the opposite way from the suspicion: the thing
exists, and the brief says build it.

**1 — `role-form-descriptor.ts` serves none of it.** All 395 lines read. It declares role
identity and detection vocabulary — `kind`, `packId`, `familyId`, `cluster`, `formEnabled`,
`levelLadder`, `detection{occupationTerms, machineTerms, levelTerms}`, `fresher` — and
exports only `conflictTermsFor`, `nonEmptyTuple` and two boot-time coherence assertions. No
step, no field, no input type, no validation rule, no required flag, no conditional
visibility, no `affects_matching`.

A step-and-field server does exist: `TradeFormService.schema()`
([apps/api/src/profiling/form/trade-form.service.ts](apps/api/src/profiling/form/trade-form.service.ts))
at `GET /profiling/form`, covering roughly five of P8's eight asks. It is worker-only, reads
worker QuestionPacks, and is guarded `WorkerAuthGuard + ConsentGuard` — a precedent to copy,
not a base to extend. **So P8 and P10 do not become "extend it". They stay builds, with a
named precedent.** Both briefs are still wrong, for other reasons.

**2 — TD42 is retired, and P4 would breach the fence that retired it.**
[docs/decisions/0036-matching-algorithm-v1.md:83](docs/decisions/0036-matching-algorithm-v1.md)
— *"Boost has been purchasable and ranking-inert since it shipped (TD42, proven by a CI
test). It now lifts a boosted job in the worker feed."* Live at
[apps/api/src/match/match-feed.repository.ts:160-162](apps/api/src/match/match-feed.repository.ts)
as the FIRST `ORDER BY` term. Fenced by
[apps/api/src/match/boost-fences.test.ts](apps/api/src/match/boost-fences.test.ts), fence (c):
*"BOOST NEVER TOUCHES THE COMPANY'S LIST… Money orders jobs for workers; it never orders
workers for money."*

P4 says *"Work in packages/match-engine"* and put `boostTier` in the rank key. That rank key
is the **company's candidate list**, pinned to the `listCandidates` SQL by
[apps/api/src/match/rank-parity.test.ts:13-25](apps/api/src/match/rank-parity.test.ts).
Following P4 literally puts money into the workers-for-payers ordering — the one thing fence
(c) exists to forbid.

**3 — the caps ship, with different numbers.**
[apps/api/src/unlocks/unlocks.service.ts:847-862](apps/api/src/unlocks/unlocks.service.ts):
`UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY` (default **5**, rolling **24 hours**) and
`UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK` (default **10 distinct payers**, rolling **7 days**),
both config at
[packages/config/src/server.ts:1098-1099](packages/config/src/server.ts). The brief asks for
5-per-7-days and 15-per-30-days. **No 30-day window exists anywhere on this path.**

The invariant already holds structurally: line 75-76 — *"worker CAPS — atomic check-and-write
under an advisory lock on worker_id… **caps precede payment**"* — cap at :234, debit at :244,
ledger at :265, one transaction, one advisory lock.

**4 — the push floor exists, elsewhere, and is retired.**
[packages/reach-engine/src/ranking.ts:11](packages/reach-engine/src/ranking.ts) —
`const DEFAULT_PUSH_FLOOR = 0.4; // below this a worker still appears, just isn't
push-notified`, applied at `:78` as `pushEligible: s.score >= pushFloor`. `0.4` **is** 40/100;
the scale is not the defect.

Three things are. It cannot live in the push processor — `PushJobData`
([apps/api/src/queue/queue.constants.ts:111-119](apps/api/src/queue/queue.constants.ts))
carries `workerId, sourceEventId, eventName, deviceIds` and no score. Nothing on the push
path reads `pushEligible`. And
[docs/decisions/0034-worker-push-notifications.md:16-18](docs/decisions/0034-worker-push-notifications.md)
rules push scope **"SECURITY ALERTS ONLY"**, with job pushes *"explicitly deferred"* — so
there is no job push for a floor to gate. P7_CHECK item 4 cannot produce a RED result.

**5 — one tier concept in the named packages, five sites repo-wide.** `grep -rni tier
packages/reach-engine/` returns **0** (control: `score` returns 302 in the same command
shape; `tier` in `match-engine/src` returns 169). So "delete the old tier logic from both
engines" names nothing a builder can find.

But the survey's first answer — "therefore only one implementation exists" — did not survive
refutation. `matchTierFor` has **zero production callers**; the tier actually written to
`job_reach.match_tier` is re-derived in SQL in three places
([apps/api/src/match/worker-skills.repository.ts:280](apps/api/src/match/worker-skills.repository.ts)
and `:360`,
[packages/db/src/materialize-job-reach.ts:158](packages/db/src/materialize-job-reach.ts)).
And that duplication is deliberate: rank-parity.test.ts:13-14 — *"V1's rank key exists in
EXACTLY TWO places in this codebase, and that duplication is **unavoidable rather than
sloppy**."* **P2's invariant is already false, and a builder enforcing it literally would
delete the indexed-sort SQL path.**

---

## The one fact that reframes everything: P1 is built

Ten of the eleven phase surveys independently concluded "matching_catalog does not exist, P1
was never started". On main, that is true — `git grep -i matching_catalog` over
`*.ts *.tsx *.sql *.py *.dart` exits 1, and migrations stop at `0098`.

**It is also misleading.** P1 is finished, pushed, and deliberately held:

- Branch `origin/p1-matching-catalog`, carrying `packages/matching-catalog/`
  (types, validate, fixture, a 257-line test) and
  `apps/api/src/match/matching-catalog.{controller,dto,repository,service,service.test}.ts`
- Migration `0099_overrated_fantastic_four.sql` (main is at 0098)
- Open **draft PR #1387**, base `main`, titled
  **"[DO NOT MERGE — blocked on role-registry ruling] P1 matching_catalog"**

So P2, P5, P6, P7 and P8 are not blocked on unbuilt work. **They are blocked on one merge,
which is blocked on one set of signatures** — R1 to R4, whose signature lines are blank
(worksheet lines 388, 444, 467, 616). That is a materially different problem, with a
materially different fix.

Three consequences the briefs do not know:

1. **PARKED.md is documenting a branch as if it were main.** P-002 cites
   `apps/api/src/match/matching-catalog.service.ts` as a live location; that file exists only
   on `p1-matching-catalog`. P-002 also says no `matching_catalog.published` event exists —
   commit `8562729d` on that branch is titled `feat(events): matching_catalog.published`.
2. **P1 is built, unmerged AND unchecked.** There is no `docs/qa/evidence/P1/`. Nobody ran
   P1_CHECK's four invalid-catalog rejections, its auth refusal, or its single-active-row
   constraint against that branch.
3. **The two chains are not independent.** `docs/agent/README.md:42` presents Matching and
   Posting as parallel. P8_BUILD:35-36 sources every chip option set from `matching_catalog`,
   so the Posting chain sits behind the same merge and the same signature.

---

## Chain state, before any individual verdict

- **`docs/qa/evidence/` contains exactly two entries: `P0` and `PX`.** P0's verdict is
  **FAIL**. `docs/agent/README.md:47` — *"Did the last VERDICT.md say PASS? If not, do not
  start the next phase."* **On the repo's own rule, no phase in either chain may start today.**
- **All seven rulings R1–R7 are unsigned.** Signature lines blank at worksheet 388, 444, 467,
  616, 705, 745, 774. `BUILD_RULES.md:29` makes settling one a full stop. R1 gates P3, R7 *is*
  P5, R6 gates P12, R4-d gates the role count in P2/P4/P8/P10.
- **Both source-of-truth documents named by BUILD_RULES are absent from this repository.**
  `BadaBhai_MVP_Matching_and_Posting_Execution_Spec_2026-09-01.md` and
  `BadaBhai_MASTER_CONTEXT_2026-07-23` return zero files. So "the locked rule" and "section
  B5 of the spec" cannot be read or checked by either session.
- **Nobody applies migrations between BUILD and CHECK.** `BUILD_RULES.md:21-22` forbids the
  builder; the two-session protocol has no step in between. P1, P3 and P8 are therefore
  uncheckable as specified, and P4, P5, P6, P9 and P12 each have check items needing a live
  schema or a running route.
- **All fifteen briefs landed in one commit**, `22d4b88c`, 2026-09-02 14:23. They were written
  together from the external spec, without a codebase audit. That is the shape of the error
  pattern below.

### ADR-0036 is the pivot

[ADR-0036](docs/decisions/0036-matching-algorithm-v1.md), **Status: Accepted** (owner ruling
2026-07-31), adopts Matching V1 and retires the weighted engine. With it retire:
**`hot`**, **`pushFloor`**, the **35/20/15/15/10/5 ledger**, **PACE**, **sort-never-block**,
and **TD42** ([docs/registers/team-decisions.md:249-250](docs/registers/team-decisions.md)).
`MATCH_V1_ENABLED` is default **false** everywhere, so both engines ship side by side on
purpose during cutover.

**Five briefs — P2, P4, P5, P6, P7 — are written against the retired half.** That is the
single largest source of error in the set.

---

# Per-phase verdicts

## P2 — one shared tier resolver

**Verdict: BRIEF IS WRONG** · **Recommendation: REWRITE BRIEF**

The artifacts do not exist, so the phase is also unbuilt — but it must not be built as written.

- `resolveMatchTier`, `tradeFactor`, `functionMultiplier`, `collarTierBand` appear in **zero**
  source files, in any spelling.
- `tradeFactor = adjacency × functionMultiplier × collarTierBand` is a weighted score.
  [0036:32](docs/decisions/0036-matching-algorithm-v1.md) — *"Nothing is hidden by a score,
  because at this layer there is no score."*
- Tier bands A/B/C/D contradict a closed `{1,2}` integer domain pinned by **two DB CHECK
  constraints** ([packages/db/src/schema/match.ts:173](packages/db/src/schema/match.ts),
  [packages/db/src/schema/job.ts:605-607](packages/db/src/schema/job.ts)), a frozen event
  payload, and a shipped Flutter client that branches on `==1 / ==2`.
- A shared module is structurally blocked:
  [packages/match-engine/src/purity.test.ts:55-65](packages/match-engine/src/purity.test.ts)
  pins the module list to exactly eight filenames, and `:85` allows imports of
  `@badabhai/taxonomy` and `zod` only.
- *"Never exclude the worker"* (line 23) is sort-never-block, which
  [0036:34](docs/decisions/0036-matching-algorithm-v1.md) retires *"deliberately, not by
  accident"*. The shipped engine **does** exclude: `matchTierFor` returns `null`.
- The INVARIANT is already false in at least five places, and rank-parity.test.ts documents
  that duplication as unavoidable.
- *Withdrawn from the survey:* P2_CHECK:13's literal grep is fine — `0.85` returns one
  unrelated hit, and it is not one of the protected weights.

## P3 — function and collar_tier columns

**Verdict: NOT BUILT** · **Recommendation: BLOCKED ON RULING**

Genuinely unbuilt: `collar_tier` and `function_required` appear only in phase briefs and the
P0 worksheet — zero source files.

- **R1 is open**, and P3_BUILD:16 arms its own HALT on exactly that. The correct outcome of a
  P3 session today is HALT, not a migration.
- The table is **`worker_skill`, singular**
  ([packages/db/src/schema/match.ts:35](packages/db/src/schema/match.ts)). P3_CHECK:4, :12 and
  :14 all say `worker_skills`; the check query errors as written. (`job_postings` is correct.)
- This repo has **no Postgres enum types** — zero `CREATE TYPE` across 0000-0098. The
  convention is `text` + `$type<>()` + a CHECK.
- P3_CHECK:6 has no HALT branch and mandates FAIL "phase not built" for the situation
  P3_BUILD:16 orders. The two halves contradict each other.

## P4 — feed ranking order, safe boost, exposure balance (TD42)

**Verdict: BRIEF IS WRONG** · **Recommendation: BLOCKED ON RULING**

- **Four of the nine named rank terms exist in zero source files**: `functionSatisfied`,
  `boostTier`, `exposureBalance`, and `TENURE_MONTHS`. The real key is six terms at
  [rank.ts:66-89](packages/match-engine/src/rank.ts).
  (`skillMonthsBucket(6)` is name drift, not absence — bucketing happens upstream at
  `derive.ts:69` via `cfg.monthBucket`, default 6.)
- **The brief conflates two disjoint orderings.** Its key is the candidate list (tail
  `workerId`); its property test is about boosted vs unboosted **jobs**, a feed concern. Boost
  and skill-months never coexist in one query.
- **`job_reach` has no `engine_version` column and never has.** Five columns:
  `job_posting_id, worker_id, match_tier, matched_skill_id, computed_at`. `engine_version`
  lives on `applications`. P4_CHECK item 5 is unexecutable.
- *Withdrawn:* the survey claimed no "boost reorders within relevance" rule exists. It does —
  the FLOOR-INVARIANCE CONTRACT at
  [reach-engine.property.test.ts:351](packages/reach-engine/src/reach-engine.property.test.ts),
  written against the retiring engine.
- Blocked because you must first say **which of the two orderings P4 means**; either answer
  then needs CEO sign-off and its own ADR under spec Policy 23.

## P5 — employer facets and small-pool hot tag

**Verdict: BRIEF IS WRONG** · **Recommendation: BLOCKED ON RULING**

**P5 is verbatim option (a) of ruling R7, and R7 is unsigned** (worksheet:766, signature line
774 blank). `BUILD_RULES.md:29` makes settling R1–R7 a full stop. The brief converts an
explicitly-labelled open question into a build instruction.

- `HOT_TOP_RATIO` exists in zero source files. The real constant is `DEFAULT_HOT_FRACTION`,
  and the **0.12 value is correct and already shipped**
  ([ranking.ts:10](packages/reach-engine/src/ranking.ts)).
- **The 70-candidate floor does not exist, and the shipped behaviour is its opposite.**
  `ranking.ts:69` — `Math.max(1, Math.round(n * hotFraction))` guarantees **at least one hot
  worker for any non-empty pool**. The only gate on the tag is trade relevance.
- The brief's 70 traces to worksheet:768, which asserts *"the 70-candidate floor where the hot
  tag is already suppressed"* — **that claim is false against shipped code**, and the brief
  inherited it.
- `hot` is retired by ADR-0036.
- **The change would break PACE.** `pace.service.ts:195` —
  `return rankWorkersForJob(spec, signals).filter((r) => r.hot).length;` — PACE's supply
  measure *is* the hot count. A 70-floor makes every sub-70 posting report supply 0, latch
  permanently thin, and fire endless widen waves. **P5 runs before P7 in the README order.**

## P6 — contact caps and boost supply gate

**Verdict: PARTLY BUILT** · **Recommendation: REWRITE BRIEF**

**Item 1 is shipped.** Caps, denial state, deny reason, two events, cap-before-payment, one
transaction, advisory lock against the race P6_CHECK item 4 asks about — all live at
[unlocks.service.ts:75-76, 233-241, 847-862](apps/api/src/unlocks/unlocks.service.ts). The
numbers differ (5/24h and 10-payers/7d versus the briefed 5/7d and 15/30d) and there is no
30-day window on this path. Changing them is an ADR-0010 amendment, plus a new value in the
closed `UNLOCK_CAP_WINDOWS` enum — not a build.

**Item 2 is half shipped.** `assertBoostSupply`
([posting-plans.service.ts:541-563](apps/api/src/posting-plans/posting-plans.service.ts))
reads `cfg.boostSupplyFloor`, counts `job_reach`, emits `job_posting.boost_refused`. The
genuine gap is that it gates at **purchase**, and P6 wants it at **offer** — an additive
change, not the "wrong layer" P6_CHECK:20 calls it. (It also fails **open** on an unreadable
reach count.)

Three brief errors:
- *"The floor comes from matching_catalog"* — it comes from `match_config.boost_supply_floor`
  (default 25, [match-engine/src/config.ts:61](packages/match-engine/src/config.ts)), which
  ADR-0036 §8 names. P1's catalog payload has **no** boost-floor field, so this stays wrong
  even after #1387 merges.
- *"job_reach count for that role and radius"* — `job_reach` has no role column and no radius
  column, and no radius concept exists in the schema.
- **P6_CHECK item 1 is unobservable.** `unlock-response.ts:7-11` — *"The internal `deny_reason`
  enum NEVER crosses the HTTP boundary… There is intentionally NO `reason` field on this type,
  so a leak is a compile error."* Every deny returns a byte-identical body at a constant 200.
  A checker must read the DB row or the event.
- P6_BUILD:10 cites *"relevance sorts, never blocks"* as a locked rule; ADR-0036:34 retired it.

## P7 — turn on PACE, add the push floor

**Verdict: PARTLY BUILT** · **Recommendation: BLOCKED ON RULING**

- **ADR-0036 retires PACE.** *"PACE retires with the weighted engine… Its auto-widening
  contradicts V1's rule that a company's approved reach set is frozen. **This is flagged for
  explicit owner acknowledgement.**"* P7 says turn it on. That acknowledgement appears
  nowhere in the repo.
- **The push floor exists** (see above), in the wrong place for the brief, and is retired by
  the same 2026-07-31 ruling that retires `hot`.
- **ADR-0034:16-18 scopes push to SECURITY ALERTS ONLY**, job pushes *"explicitly deferred"*.
  Only two templates carry `push: true`, both security. `PUSH_ENABLE_REAL` defaults false, so
  `MockPushProvider` is bound and **no push leaves the process** — P7_CHECK item 4 passes
  vacuously for every worker at every score.
- The adjacency wave needs both PR #1387 and an owner-ratified map:
  [ADR-0021:93](docs/decisions/0021-pace-supply-widening-and-ops-alert.md) forbids inventing
  one.

## P8 — job posting drafts and checkpoints

**Verdict: NOT BUILT** · **Recommendation: REWRITE BRIEF**

Neither table exists. But all three of the brief's HALTs are wrong about current main:

- **HALT 1 (Redis).** The job-posting draft already lives in Postgres —
  `payer_job_posting_chat_sessions.draft`
  ([packages/db/src/schema/payer.ts:707-710](packages/db/src/schema/payer.ts)), shipped by
  signed ADR-0035. The brief neither cites nor amends it.
- **HALT 2 (last-write-wins).** A generic cross-device draft primitive already ships —
  `payer_form_drafts` (`payer.ts:775-795`), documented as *"DELIBERATE FORWARD SCAFFOLDING…
  the reusable resume-any-half-filled-payer-form primitive for future workstreams"*, with
  `job_posting` as its own named example. It is exactly last-write-wins: five columns, one row
  per `(payer, form_type)`, no version. **P8 must claim it, amend ADR-0035, or dispose of it —
  not silently create a competing table.**
- **HALT 3 (status = draft in job_postings).** `job_postings.status` already **defaults** to
  `'draft'` ([schema/job.ts:89](packages/db/src/schema/job.ts)) and the CHECK permits it. The
  brief describes shipped behaviour as a forbidden mistake — and P9_BUILD:7 then instructs
  exactly that insert.

Also: `matching_catalog` is P1's (PR #1387); `function` and `collar_tier` are P3's; `shifts`
and `benefits` are in P1's catalog payload nowhere at all; and "22 roles" is unsigned.
**Split the phase** — the tables/checkpoints/concurrency half is buildable once the prior-art
question is settled; the `GET /schema` half is blocked on P1 and P3.

## P9 — separate publish, verify, and plan

**Verdict: PARTLY BUILT** · **Recommendation: BLOCKED ON RULING**

Verification is **observable everywhere and enforced nowhere**: `verification_status` ships
with a 3-value CHECK ([schema/job.ts:95-98, 271-275](packages/db/src/schema/job.ts)), the ops
verify route ships, the Verified badge ships — and no read path gates on it. The column's own
docblock calls it a badge and *"NOT a RANK input"*. The brief treats it as a visibility gate.
That is a design question, not a build.

- **`pending` is not a legal value.** The domain is `('unverified','verified','rejected')`. The
  briefed INSERT raises a constraint violation.
- `emit job_posting.submitted` — the event registry carries a **reasoned refusal** of a publish
  event on a no-second-writer argument
  ([packages/event-schema/src/registry.ts:347-350](packages/event-schema/src/registry.ts)).
- `open -> job_reach is built, engine_version stamped` — `job_reach` has no version column.
- `affects_matching = true -> NEW engine_version` — it is a single **global** value on one
  `match_config` row, reserved by Policy 23 for a rank-key change with CEO sign-off and an ADR.
  A per-edit bump burns that token on routine posting edits.
- **Deleting the chat publish route breaks two shipped clients.** The route is live under
  `PayerAuthGuard` at
  [job-posting-chat.controller.ts:134](apps/api/src/payer-portal/job-posting-chat/job-posting-chat.controller.ts)
  and called by payer-web and the Flutter payer app. It is also specified in ADR-0035's
  endpoint table, so removing it is a supersede — an owner act. Note its docblock: *"It is an
  INPUT SURFACE, not a second job-creation path"* — it already delegates to the one
  `createForPayer`. The one-publish-path goal is largely already met.
- P9_CHECK:20 edits a `benefits` field on `job_postings`, which has no such column.
- P9_CHECK:22 edits `city` expecting a `job_reach` rebuild; the rebuild trigger keys only on
  publish or a `match_skill_ids` change.
- *"Follow section B5 of the spec"* — unresolvable; that document is not in this repository.

## P10 — payer-web wizard renders from the server schema

**Verdict: NOT BUILT** · **Recommendation: REWRITE BRIEF**

There is a posting form today
([apps/payer-web/src/app/(portal)/postings/new/posting-form.tsx](apps/payer-web/src/app/(portal)/postings/new/posting-form.tsx)),
not a schema-driven wizard. No role names are hardcoded (`cnc_turner` returns zero files in
payer-web); shift and benefit are free text, so there are no option sets to remove.

- **P10_BUILD:15 orders the client to call `drafts?status=in_progress` — an endpoint no phase
  builds.** P8 adds only `GET /schema`, and P10_BUILD:3 forbids P10 from building one.
- **P10_CHECK:9 greps for "all 22 role labels"**, which cannot be enumerated from this
  repository. The role registry declares **five**
  ([role-registry.ts:39-45](apps/api/src/profiling/roles/role-registry.ts)); the payer Flutter
  app hardcodes a different six; the worksheet counts 21 and R4-d is unsigned.

## P11 — the posting chat becomes a parser, not a writer

**Verdict: PARTLY BUILT** · **Recommendation: BLOCKED ON RULING**

The posting chat exists as a full interview engine
(`apps/ai-service/app/job_posting_chat/{interview_engine,answers,prompts,question_bank}.py`),
so "make it a parser" is coherent work. The brief is right that a reusable worker-side
validator exists — `drop_model_taxonomy_ids` covering the `role_` prefix
([profile_extractor.py:297,325,341](apps/ai-service/app/profiling/profile_extractor.py)).

- **The ₹4-per-profile cap does not exist.** It was explicitly raised:
  [config.py:496-507](apps/ai-service/app/config.py) — *"RAISED for the generalized profiling
  flow (**Rs 4/6 -> Rs 15/20**)… Rs 4 was not a budget for that shape of work; it was a budget
  for not doing it."* Current values are `ai_target_profile_cost_inr = 15.0` and
  `ai_cost_alert_profile_inr = 20.0`, and both are ALERT/TARGET, not caps. (The brief's other
  cost claim is **true**: the interview turn does run on `gemini-2.5-pro`, per #1237.)
- *"The validator REJECTS **any** canonical id"* is over-broad against **shipped code**, in two
  directions. The worker-side mechanism is `drop_model_taxonomy_ids`, and its docblock is
  explicit: *"A **DROP, never a raise.** Canonicalization must never block extraction — that is
  the TAX-8 guarantee."* A validator that *rejects* would break that fail-open posture. And for
  roles specifically the model is deliberately **offered** the closed id set — `ROLE_IDS`
  rendered into the prompt at
  [canonical_roles.py:76](apps/ai-service/app/profiling/canonical_roles.py), with output run
  through `normalize_role_id` at `:119`, described as *"the same closed-set trust boundary"*.
  So role ids from the model are normalized against a whitelist, not refused outright.
  (ADR-0028 describes this seam but is **Status: Proposed**, not signed, and produces no code —
  do not cite it as the authority here.) Reconciling "reject" with "drop, fail open" is an
  owner call, and routes to HALT under `BUILD_RULES:39`.
- *"A second copy is a FAIL"* (P11_CHECK:15) contradicts the repo's own discipline: the parse
  gates are a **deliberate mirrored pair**, Python and TypeScript, held in sync by a test.
- The delta shape `{field_id, value_raw, value_normalized, confidence, evidence_span}` is
  incompatible with the P8 checkpoint endpoint it is told to POST to, which requires
  `step_id`, `expected_version` and an idempotency key.

## P12 — Flutter payer app: draft and resume only

**Verdict: PARTLY BUILT** · **Recommendation: BLOCKED ON RULING**

**R6 is unsigned** (worksheet:745, blank) and P12_BUILD:3 orders an immediate stop. The
brief's premise is correct: `.github/CODEOWNERS` has rows for `/apps/web/`,
`/apps/worker-app/` and `/apps/ai-service/` and **none for `/apps/payer-app/`**.

The app is far more built than the brief implies — twelve feature modules including
`job_posting_chat` (with `draft_preview.dart` and a cross-device `chat_sessions_cubit`),
`credits`, `jobs`, `org`, `capacity`.

- **The invariant already holds and is documented.** `credits_screen.dart` — *"There is NO
  in-app purchase surface here."* The web hand-off P12 asks for **already exists** and is
  deliberately hidden: `kShowBuyCreditsOnWeb = false`, because pointing out to a web purchase
  for virtual currency is Play **anti-steering** surface. P12 would re-enable a surface
  switched off for a documented store-policy reason.
- **P12_CHECK item 1 fails today on a code comment** — `credits_screen.dart:54` is `/// billing
  is wired).` Read as written ("Any hit is a FAIL"), the phase fails on pre-existing prose.
- **P12_CHECK item 4 fails on pre-existing code** — `post_job_screen.dart:80-87` hardcodes six
  trades ('CNC Setter', 'VMC Setter', …) and a `vacancy_band` enum.
- **P12_CHECK:5 lists as a build ARTIFACT something the builder is forbidden to produce**:
  naming the payer-app owner is R6.

---

# Every brief that is factually wrong

67 brief errors across ten briefs, regrouped thematically below, worst first. Full per-phase
detail is above.

Two notes on the arithmetic, so the counts are not over-read. Groups **A to E do not partition
the 67** — a few errors appear under two headings (a wrong constant that is also a signed-ruling
conflict), and several near-duplicates across briefs are collapsed into one row. Groups **F and
G are additional**: they come from the cross-phase and PARKED passes, not from the per-brief
counts.

### A. Contradicts a signed, Accepted ruling — 13 findings

| Brief | Says | Signed ruling it contradicts |
|---|---|---|
| P2:6-11, 13-16 | a multiplicative `tradeFactor` and A/B/C/D bands | ADR-0036 — no weight, no coefficient, no blend; tier is `{1,2}` |
| P2:20-23, P6:10 | *"relevance sorts, never blocks"* is a locked rule | ADR-0036:34 retires sort-never-block *"deliberately"* |
| P2:3-4 | one module shared by both engines | `purity.test.ts:55-65, 85` — 8 pinned files, 2 allowed imports |
| P4:3-6 | `boostTier` in the match-engine rank key | ADR-0036 §7 fence (c), CI-gated `boost-fences.test.ts` |
| P5 (whole) | build the attribute facet | **R7 option (a), unsigned** |
| P5:10-12 | small-pool `hot` suppression | ADR-0036:97 — *"`hot` does not exist in V1"* |
| P7:5 | set `PACE_ENABLED` true | ADR-0036 — *"PACE retires… flagged for explicit owner acknowledgement"* |
| P7:14-15 | a push floor for job notifications | ADR-0034:16-18 — push is **SECURITY ALERTS ONLY** |
| P9:26 | delete the chat publish route | ADR-0035's endpoint table; two shipped clients call it |
| P9:31 | new `engine_version` per payer edit | spec Policy 23 — CEO sign-off + an ADR |
| P3:16 / P12:3 | build if R1 / R6 is closed | both unsigned; `BUILD_RULES:29` full stop |

Thirteen findings, not fourteen: a P11 row asserting a conflict with ADR-0028 was **withdrawn
during verification** — ADR-0028 is `Status: Proposed`, not Accepted, and produces no code. The
underlying P11 defect is real but is a conflict with shipped behaviour, and moves to group C.

### B. Names a file, table, column, route or constant that does not exist — 21 findings

| Named | Reality |
|---|---|
| `matching_catalog` (P2:18, P5:7, P6:13, P7:11, P8:36) | zero code hits on main; built on PR #1387, held |
| `resolveMatchTier`, `tradeFactor`, `functionMultiplier`, `collarTierBand` (P2) | zero source files |
| `functionSatisfied`, `boostTier`, `exposureBalance`, `TENURE_MONTHS` (P4) | zero source files |
| `job_reach.engine_version` (P4:16, P9:18, P4_CHECK:19) | `job_reach` has five columns; version is on `applications` |
| `job_reach` role + radius columns (P6:12) | neither exists; no radius concept in the schema |
| `worker_skills` (P3_CHECK:4, 12, 14) | the table is `worker_skill`, singular |
| `HOT_TOP_RATIO` (P5:10) | the constant is `DEFAULT_HOT_FRACTION` (value 0.12 is right) |
| `verification_status = pending` (P9:7) | domain is `unverified / verified / rejected` |
| `job_postings.benefits` (P9_CHECK:20) | no such column |
| `drafts?status=in_progress` (P10:15) | no phase builds this endpoint |
| `TIER_ORDER` (P2_CHECK:9) | exists only in a stale reference doc |
| enum types (P3:5) | this repo has zero Postgres enums by convention |

### C. Asserts current behaviour that is false — 13 findings

- **P4:1** *"This is the TD42 fix"* — TD42 was retired by ADR-0036 §7.
- **P6:5-8** contact caps described as absent — shipped, with different windows.
- **P7:16** the push floor *"does not appear in the codebase report"* — it exists at
  `ranking.ts:11`.
- **P2:32** *"delete the old tier logic from both engines"* — `reach-engine` has zero "tier".
- **P2:34** the INVARIANT — already false in five places, deliberately.
- **P8:7** *"Redis buffer loss"* as the draft risk — the draft is already in Postgres.
- **P8:12** *"status = draft in job_postings is a HALT"* — that is the shipped default.
- **P5:10** the 70-candidate floor — does not exist; shipped code guarantees the opposite.
- **P11:22** the *"4 rupees per profile cap"* — raised to ₹15/₹20, and never a cap.
- **P12:9-10** the payment-surface grep — returns a hit on a comment today.
- **P12:13** hardcoded Dart role labels — six already exist, pre-dating the phase.
- **P8/P10** the implied absence of any schema-serving precedent — `TradeFormService.schema()`
  ships.
- **P11:15-16** *"The validator REJECTS any canonical id… This already exists on the worker
  side"* — what exists is a **drop that fails open** (`drop_model_taxonomy_ids`, *"a DROP, never
  a raise"*), and for roles the model is deliberately handed the closed id set and normalized
  against it (`canonical_roles.py:76, 119`). Neither is a reject.

### D. Unsettled numbers and unresolvable references — 8 findings

- **"22 roles"** asserted as fact in P2:27, P2_CHECK:5, P4:24, P8:36, P10:9, P10_CHECK:9.
  P0_BUILD:31 *asks* the question; **R4-d is unsigned**; the registry declares **five**; the
  payer app hardcodes a different **six**; the worksheet counts **21**.
- **Both source-of-truth documents** named by `BUILD_RULES:3-5` are absent from the repo, so
  P9:3's *"section B5 of the spec"* cannot be read by either session.
- **The "Sept-1 codebase report"** cited by P7:16 and P8:7 is
  `docs/reference/BADABHAI-CODEBASE-INTELLIGENCE-REPORT.md` — tracked, dated September 1 2026,
  and **not in BUILD_RULES' authority list**. It invents `job_reach` columns
  (`score`, `rank_position`, `engine_version`), a `TIER_ORDER` constant, `rankByScore()` and a
  fabricated match-engine config list. **It is the probable source of several errors above and
  will seed the next brief too.**

### E. Check items that cannot produce a RED result — 6 findings

These are worse than wrong, because they pass and certify nothing.

- **P6_CHECK:10** — `deny_reason` never crosses the HTTP boundary by design.
- **P7_CHECK:17-18** — nothing on the push path reads `pushEligible`, and `PUSH_ENABLE_REAL`
  is false, so `MockPushProvider` sends nothing. Passes for every worker at every score.
- **P5_CHECK:16** — a bare grep for `facet` substring-matches `surfaceTintColor` and the NCO
  corpus.
- **P12_CHECK:9-10, :13** — fail today on a comment and on pre-existing code.
- **P2_CHECK:9** — greps for a constant that exists only in a stale doc.
- **P1/P3/P8/P9/P12 CHECKs** — require a live schema nobody is assigned to apply.

### F. Phase collisions the briefs do not mention — 8 findings

- **P5 breaks P7**, and P5 runs first. PACE's supply measure is the hot count.
- **P2 and P4 both consume `function`** and would double-count it — once inside `tradeFactor`,
  once as a separate rank term.
- **P2 and P4 both define "tier"** and neither references the other, leaving P4's first sort
  key undefined after P2.
- **P4 and P5 both reorder the candidate list** by different mechanisms with no stated
  precedence — while P4_CHECK:17 demands byte-identical order.
- **P4 and P9 both bump one global `engine_version`** on unrelated triggers.
- **P8, P10, P11, P12 are four consumers of one checkpoint endpoint** carrying three
  incompatible payload shapes.
- **P9 then P11** leaves the chat able to collect input and unable to publish anything.
- **P4 works on match-engine; P5 and P7 work on reach-engine** — opposite sides of
  `MATCH_V1_ENABLED`. No brief says the chain is split across two mutually-retiring engines.

### G. PARKED.md corrections found on the way

- **P-002 documents a branch as if it were main.** Its cited file exists only on
  `p1-matching-catalog`, and the `matching_catalog.published` event it says is missing is
  commit `8562729d` on that branch.
- **P-001 is stale on a stated fact.** It says *"there is no `.prettierignore` today"*;
  `.prettierignore` is tracked at HEAD, 3888 bytes.
- **P-006 is worsened by P8 and P9** — every new controller file adds load to
  `canary-coverage.test.ts`, which imports all 70 of them.
- **P-005 removes the local build gate for P10 and P12.**

---

## What was not checked

Stated so it is not mistaken for coverage.

1. **P1_BUILD/P1_CHECK were never surveyed** — only the table's existence. P1 is built,
   unmerged **and unchecked**; nobody ran P1_CHECK against `p1-matching-catalog`.
2. **No test was run, no database touched, no service started.** Every invariant's runtime
   enforceability is unverified.
3. **R2, R3, R4 and R5 were not traced** to the phases they gate. Only R1, R6 and R7 were.
4. **`BADABHAI-CODEBASE-INTELLIGENCE-REPORT.md` was not read end to end** — four wrong claims
   were found incidentally in 108KB.
5. **Whether `MATCH_V1_ENABLED`, `PACE_ENABLED` or `PACE_ADJACENCY_ENABLED` are true in any
   deployed environment.** Every "inert today" claim above is about declared defaults.
6. **Whether a mobile deprecation issue is filed** for deleting the ADR-0035 chat publish route
   (CLAUDE.md §6 requires one).
7. **`apps/android`** was examined by nothing, and no brief mentions it.

---

## Questions, batched

1. **PR #1387.** Is it held only on R1–R4, or is there more? It gates P2, P5, P6, P7 and P8.
2. **Is ADR-0036 still in force?** It is Accepted and unsuperseded in the repo, and five briefs
   are written against the half it retires. If Matching V1 has been dropped, nothing in
   `docs/decisions/` records it, and P2/P4/P5/P6/P7 all need rewriting against whatever
   replaced it.
3. **PACE.** ADR-0036 flags its retirement *"for explicit owner acknowledgement"*. Has that
   been given? P7 says turn it on.
4. **21 or 22 roles?** R4-d is unsigned and six brief lines assert 22. The registry declares 5.
5. **The contact caps.** Keep the shipped 5/24h + 10-payers/7d, or amend ADR-0010 to the
   briefed 5/7d + 15/30d? The latter also needs a new `UNLOCK_CAP_WINDOWS` enum value.
6. **The draft table.** Does P8 claim `payer_form_drafts` (built as forward scaffolding for
   exactly this), amend ADR-0035, or create a third store?
7. **Verification.** Badge (shipped) or visibility gate (P9's invariant)?
8. **Who applies migrations between BUILD and CHECK?** Unassigned today, which makes P1, P3 and
   P8 uncheckable.
9. **The Sept-1 codebase report.** It is cited by name in two briefs, is not in the authority
   list, and is provably wrong about this schema. Retire it, correct it, or rank it?
10. **Which briefs do you want rewritten?** I have not touched any of them.
