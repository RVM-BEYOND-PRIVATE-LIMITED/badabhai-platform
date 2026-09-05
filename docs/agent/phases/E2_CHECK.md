PHASE-ID: E2
STATUS: BLOCKED ON THREE GATES (E2_BUILD.md STATUS). A correct session run TODAY ends
VERDICT PASS, reason "phase correctly halted", with a HALT record and NO code. Absent code
is NOT "phase not built" here — shipped search code, while ADR-0040 is unsigned and E4 has
not landed, IS the FAIL. Items 1-3 decide that; run them first and stop if any fires.

INVARIANT: a worker who has not consented to `employer_sharing` never appears in a candidate
search result, in either mode, and is never counted in `matched` or in `total`.

R-E4 APPLIES TO THIS WHOLE FILE, AND IT IS NOT A FOOTNOTE. The workers on the live database
are testers (owner ruling, 2026-09-05) and no worker data has been migrated from anywhere.
**Every item below that touches data runs against SEEDED LOCAL DATA against a schema Prakash
has applied.** A result count from this phase is a fact about the seed and nothing else; a
verdict that reports one as a supply figure is wrong even when the number is right. An item
needing rows nobody has seeded is recorded NOT EXECUTABLE — never as a PASS.

EXPECTED ARTIFACTS (once the gates clear): a candidates module with a controller, DTO,
service and repository; a module boot test; a `guard-contract.test.ts` registration; a
payer-web candidates page. NO change under `apps/api/src/reach/` or `packages/reach-engine/`.

HOW TO READ THE LABELS.
  [GATE]        — decides whether the phase was allowed to run at all.
  [GUARD]       — must be GREEN at the phase base. Each was run against `f72a7a79` while
                  this brief was written and its base result is recorded. A GUARD red at
                  base cannot distinguish this build from the world: report it as a broken
                  check, never as a FAIL.
  [DELIVERABLE] — must be RED at the phase base. Green at base means there was nothing to
                  build, and that is the finding.

CONVENTION: grep exits 1 on zero matches. Do not run under `set -e`. Paste raw output AND
the exit code for every item.

1. [GATE · base: the slot is dotted and blank] Is the ruling signed?
   sed -n '794p' docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md
   grep -n '^- \*\*Status:\*\*' docs/decisions/0040-candidate-search-filter-behaviour.md
   Base: line 794 reads `Signed (CEO / RVM): .......................  Date: .................`
   — dotted and blank — and ADR-0040's status is "PROPOSED — UNSIGNED".
   READ THE LINE, DO NOT TEST IT FOR EMPTINESS. Line 794 is not blank at base and never was;
   it is a dotted signature template. A check written as "blank means unsigned" would read
   this line as SIGNED. That failure has already happened once in this repository, on this
   exact worksheet, and it is why this item quotes the expected text instead.
   If BOTH are still unsigned and the build shipped search code, that is the FAIL: a builder
   settled R1-R7 (docs/agent/BUILD_RULES.md:31).
   If EITHER is now signed, this brief may be stale — say so and re-read ADR-0040 before
   proceeding, rather than assuming these instructions still describe the ruling.

2. [GATE · base: 1 hit — E4 has NOT shipped] Did E4 ship first (owner ruling R-E3)?
   grep -c "is an unwired seam" apps/api/src/match/worker-skills.service.ts
   Base: 1 — `setWants` still throws, so E4 has not landed.
   A count of 1 here TOGETHER WITH shipped search code is a FAIL, and the fail sentence must
   say WHY rather than only WHAT: a worker made visible to paying strangers by this phase
   has no exit but account deletion. "E4 not shipped" alone reads as a scheduling nit.

3. [GATE] THE EMPTY-RESULT TRAP, and it is a real pass/fail item rather than context.
   Establish the world first:
   grep -n "rebuildQuietly" apps/api/src/profiles/profile-extraction.processor.ts
   grep -rn "rebuildQuietly" apps/api/src/profiling
   grep -n "employer_sharing" apps/worker-app/lib/features/consent/presentation/cubit/consent_cubit.dart
   Base: a hit at profile-extraction.processor.ts:501, exit 1 for the second, and exit 1 for
   the third. So on main a completed trade form derives NO `worker_skill` rows, and no client
   requests `employer_sharing`, so no worker acquired through the real app has it.

   THE RULE, and it inverts the usual intuition:
     - AN EMPTY RESULT SET IS A **PASS**, provided `employer_sharing` consent and `wants` are
       genuinely in the `WHERE` clause (item 5 proves that separately). Zero rows is the
       correct answer to a correct query against a world with no consenting supply. Do NOT
       write it up as a broken query, an unfinished build, or a bug.
     - A NON-EMPTY RESULT SET, run against any database whose workers arrived through the
       real app while E4 and #1425 have not landed, is a **FAIL**. There is no legitimate way
       to get rows out of that world, so rows mean a predicate was dropped.

   THE ONE LEGITIMATE EXCEPTION, and state which case you are in before reporting either
   result: a SEEDED fixture may deliberately insert a consenting worker with `worker_skill`
   rows, and then a non-empty result is correct and expected. So before judging, print what
   the seed actually contains — how many seeded workers carry `employer_sharing`, and how many
   carry a `worker_skill` row with `wants = true`. If those counts are zero and the search
   returns rows, that is the FAIL. If you cannot read the seed, this item is NOT EXECUTABLE;
   say so rather than guessing which case you are in.

   PRESCRIBED FAIL SHAPE: say that rows were returned from a population that cannot contain
   any, and name which predicate is missing from the SQL. Do NOT write "search returned
   unexpected results" — the whole danger of this failure is that it looks like success, and
   a sentence that reads as a surprise rather than as a disclosure will be triaged as a
   fixture problem.

4. [DELIVERABLE · base: RED, exit 1] The route exists.
   grep -rn "payer/candidates" apps/api/src apps/payer-web/src --include=*.ts --include=*.tsx
   Base: exit 1, no hits anywhere. Expect a controller hit and a client hit.
   Then confirm the controller is registered:
   grep -n "Candidate" apps/api/src/common/guard-contract.test.ts
   An unregistered controller is not merely untested — it is invisible to the one test that
   proves its guard is attached.

5. [DELIVERABLE] THE INVARIANT, and this is the item the phase exists for.
   Read the repository's SQL. The three membership predicates must be in the `WHERE` clause
   of the query that produces BOTH the rows and `total` — not applied in TypeScript after
   the read, and not applied to the rows but skipped for the count.
   THEN MUTATE AND WATCH IT GO RED. Delete the consent predicate, run the phase's suite, and
   confirm a test fails. A green suite after that mutation means the invariant has no guard
   and a PASS here certifies nothing — report that, do not record a PASS.
   THE MUTATION MUST BE FAITHFUL: remove the predicate, do not merely rename a variable. A
   mutation that cannot change which rows come back has not tested anything.
   PRESCRIBED FAIL SHAPE: name whether the leak is in the ROWS, in `total`, or in both. They
   are different defects — a worker counted but not listed is a much smaller harm than one
   listed, and a fail sentence that says only "consent not enforced" hides which happened.

6. [DELIVERABLE] The zero-match case, which is R-E1's whole point.
   Exercise a strict search that matches nobody. The response must be
   `{ matched: 0, total: <the eligible population>, results: [] }`.
   FAIL if `total` is 0, absent, or only obtainable by a second request. ADR-0040 Decision 3:
   a payer must never reach a state where the screen is empty and the reason is not on it.
   ALSO CHECK THE CLIENT: the page must render the count from THAT response. A design where
   the count arrives separately can paint an empty list first, which is the failure the
   ruling exists to prevent, and a server-side-only check cannot see it.

7. [GUARD · base: GREEN, empty diff] The retiring engine was not touched.
   git diff --stat $(git merge-base origin/main HEAD)..HEAD -- apps/api/src/reach packages/reach-engine
   git status --porcelain --untracked-files=all -- apps/api/src/reach packages/reach-engine
   Both expected EMPTY. Any change is a FAIL — including a change that FIXES the
   `reason`-string leak (packages/reach-engine/src/scoring.ts:199, :213). That leak is real,
   it is an open owner question, and repairing it inside this phase is the out-of-scope edit
   docs/agent/BUILD_RULES.md:33-35 forbids. The correct outcome is a PARK, not a fix.

8. [GUARD · base: GREEN, no such directory] The new module does not read the retiring pool.
   grep -rn "workerProfiles\|worker_profiles\|listSignalRows\|reach-engine" apps/api/src/candidates
   Expected exit 1 (or exit 2 at base — the directory does not exist yet, which is itself the
   correct base answer). Substitute the real directory name if the builder chose another.
   DO NOT RUN THIS OVER `apps/api/src/match`: `worker_profiles` legitimately appears SEVEN
   times there (`WorkerSkillsRepository.findLatestProfileSignals` reads it by design), so an
   unscoped grep goes red for the wrong reason and points a reader at innocent code.

9. [GUARD · base: GREEN] No weight, and no money, entered the order.
   Read the ORDER BY. `filter_match` must be a BOOLEAN — 1 or 0 — never a count, a fraction
   or a sum. FAIL on a "matched N of M" gradient: that is a weighted rank
   (docs/agent/BUILD_RULES.md:24, ADR-0036:61).
   grep -rni "credit\|plan\|boost\|capacity\|payment" <the new module directory>
   Expected exit 1. FAIL on any hit that reaches the ORDER BY — money ordering workers for
   money is ADR-0036 §7 fence (c) and docs/agent/BUILD_RULES.md:27, twice over.

10. [GUARD · base: GREEN, 232 lines] The per-posting candidate list is byte-identical.
    git diff $(git merge-base origin/main HEAD)..HEAD -- apps/api/src/match/match-feed.repository.ts apps/api/src/match/match-candidates.service.ts apps/api/src/match/rank-parity.test.ts
    Expected EMPTY. Candidate SEARCH and the APPLICANTS list are two surfaces and must stay
    two. `rank-parity.test.ts` pins `listCandidates`' SQL to `rankKeyCompare`; a change to
    either without the other is exactly what that test exists to catch, and a change to both
    together is a rank-key change needing CEO sign-off and its own ADR (ADR-0036:75).

11. [GUARD · base: GREEN] No `feed.shown` on this path, and no `engine_version` bump.
    grep -rn "feed.shown\|feedShown" <the new module directory> — expected exit 1.
    grep -rn "engine_version\|engineVersion" <the new module directory> — expected exit 1
    except as a passed-through display field. A bump burns a token ADR-0036:75 reserves for a
    genuine rank-rule change, on a surface that creates no application and freezes no
    snapshot.

12. [GUARD · base: GREEN, exit 1] No migration was run.
    git diff --stat $(git merge-base origin/main HEAD)..HEAD -- packages/db/migrations
    This phase should need no schema change at all — every column it reads exists. A
    migration here is a signal that the pool was sourced wrongly; read it before accepting it.
    THIS ITEM CANNOT CONFIRM A MIGRATION WAS NOT APPLIED to a database. The repository does
    not record that. Say so; do not claim it.

13. NOT EXECUTABLE WITHOUT SEEDED ROWS. The end-to-end proof — seed one consenting worker and
    one non-consenting worker with identical skills, search, and confirm exactly one appears
    and `total` is 1 — needs a schema Prakash has applied and rows somebody seeded. If either
    is missing, write "NOT EXECUTABLE: <which>" and do NOT record a PASS. Item 5's mutation is
    the unit-level evidence; this is the integration-level evidence, and they answer different
    questions. Do not let one stand in for the other.

RECORD IN THE VERDICT, do not check:
  - The `reason`-string leak on the legacy applicants route is still live
    (packages/reach-engine/src/scoring.ts:199, :213). Out of scope here, and an open owner
    question.
  - Whether ADR-0040's amendment of ADR-0036:61 and :65 has been reflected in ADR-0036's own
    "Superseded" header. That is an owner/docs act, not a code defect, and not this phase's.
