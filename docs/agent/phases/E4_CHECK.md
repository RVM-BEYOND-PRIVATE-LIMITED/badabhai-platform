PHASE-ID: E4
STATUS: RUNS AFTER E0, not before it (owner ruling 2026-09-05, correcting R-E3 — see
E4_BUILD.md's STATUS for why the original premise was false). Two build items are BLOCKED on
non-engineering work (the DPDP notice copy — now covering BOTH `employer_sharing` and the
NINTH, messaging purpose the owner ruled in on 2026-09-05 — and the
`CURRENT_CONSENT_VERSION` bump that must land with it). A
correct run today therefore ends with items 1-6 executed and items 7-8 recording a HALT.
A build that requested `employer_sharing` from a client WITHOUT the copy is a FAIL, not a
partial pass — see item 8.

INVARIANT: a worker who turns a skill off leaves `job_reach` in the same transaction — no
posting can reach him through a skill he has declined.

R-E4 APPLIES TO THIS WHOLE FILE, AND IT IS NOT A FOOTNOTE. The workers on the live
database are testers (owner ruling, 2026-09-05) and no worker data has been migrated from
anywhere. **Every item below runs against SEEDED LOCAL DATA against a schema Prakash has
applied.** No item here is evidence about real supply, and none may be written up as if it
were. An item that needs rows nobody has seeded is recorded NOT EXECUTABLE — never as a PASS.

EXPECTED ARTIFACTS: a `setWants` implementation, a worker-authed controller + DTO, a
clear-all route, an event, and a GitHub issue number for the Flutter UI. NO `.dart` file may
change (CLAUDE.md §6).

HOW TO READ THE LABELS. Each item is either:
  [GUARD]       — must be GREEN at the phase base. It was run against `f72a7a79` while this
                  brief was written and the base result is recorded. A GUARD that is red at
                  base cannot tell your build from the world and must be reported as a broken
                  check, not as a FAIL.
  [DELIVERABLE] — must be RED at the phase base. If it is green at base, the phase has
                  nothing to build and that is the finding.

CONVENTION: grep exits 1 on zero matches. Do not run these under `set -e`. Paste raw output
AND the exit code for every item.

1. [GUARD · base: GREEN, one hit at :59] `wants` still defaults true.
   grep -n 'wants: boolean("wants").notNull().default(true)' packages/db/src/schema/match.ts
   FAIL on zero hits. R-E2 is "visible until opt-out"; a build that made the toggle work by
   flipping the default has inverted the ruling while appearing to satisfy it.
   PRESCRIBED FAIL SHAPE (not the sentence — the shape): name the ruling (R-E2), quote the
   line as it now reads, and state what the default became. Do NOT write "wants default
   changed" alone; a checker reading that cannot tell an inversion from a type change.

2. [GUARD · base: GREEN, hits at :79-81] The reach driver index is still partial on `wants`.
   grep -n -A3 'index("worker_skill_reach_idx")' packages/db/src/schema/match.ts
   Expect `.on(t.skillId)` then `.where(sql`${t.wants}`)`. FAIL if the `.where` is gone: the
   toggle would still write the column and the worker would still be reachable, which is the
   invariant failing silently rather than loudly.

3. [DELIVERABLE · base: RED, one hit at :162] The unwired seam is gone.
   grep -n "is an unwired seam" apps/api/src/match/worker-skills.service.ts
   Expect exit 1. A hit means `setWants` still throws and the phase is not built.
   POSITIVE CONTROL, and run it: the same grep over
   apps/api/src/match/worker-skills.service.test.ts must still find the test that asserts the
   seam FAILS rather than no-ops (base: a hit near :482). If that test was DELETED rather
   than rewritten, that is a separate FAIL under `docs/agent/BUILD_RULES.md:25` — a test
   removed so a suite goes green.

4. [DELIVERABLE] `setWants` reconciles `job_reach` in the same transaction.
   Read the implementation. FAIL if the `wants` UPDATE and `reconcileReachForWorker` are not
   in one transaction, or if the reconcile is passed a set the code computed instead of one
   it read back from the database. The rebuild path does it correctly and is the reference:
   apps/api/src/match/worker-skills.service.ts:125-126.
   THEN MUTATE AND WATCH IT GO RED. Move the reconcile outside the transaction (or delete
   it), run the phase's unit suite, and confirm a test fails. A green suite after that
   mutation means the invariant has no guard and the phase's PASS is worthless — report
   that, do not record a PASS. This step is the only one that distinguishes a working gate
   from a gate that cannot fail.

5. [DELIVERABLE] The row is stamped `source='interview'`.
   grep -n "interview" in the new `setWants` body. FAIL if it writes `derived_coarse`: the
   next coarse re-derivation is permitted to overwrite that source
   (packages/db/src/schema/match.ts:26-30), so the worker's opt-out would silently undo
   itself on his next profile write. This is the failure mode nobody would notice, because
   nothing errors and the row simply comes back.

6. [GUARD · base: GREEN, exit 0 with no `.dart` files listed] No Flutter file changed.
   git diff --stat $(git merge-base origin/main HEAD)..HEAD -- apps/worker-app apps/payer-app
   and git status --porcelain --untracked-files=all -- apps/worker-app apps/payer-app
   Both expected EMPTY. Any `.dart` change is a FAIL under CLAUDE.md §6 — backend work
   crossing into the mobile owner's layer — regardless of whether the change is correct.
   The GitHub issue number must be in the build report instead.

7. [GUARD · base: GREEN, exactly 8] The build session did not mint a purpose.
   awk '/^export const CONSENT_PURPOSES = \[/,/^\] as const;/' packages/types/src/index.ts | grep -c '^  "'
   Base: 8. Expect 8 **or** 9 — the owner ruled a ninth, messaging purpose in on 2026-09-05
   (docs/decisions/E0_RELAY_DECISION_2026-09.md §A) and mints it himself.
   THE COUNT IS NOT THE TEST. Run:
   git diff $(git merge-base origin/main HEAD)..HEAD -- packages/types/src/index.ts
   FAIL if that diff adds a member, whatever the total is. `docs/agent/BUILD_RULES.md:28`
   makes adding to `consent.purposes[]` a full stop and the ruling does not transfer it to a
   builder; this phase REQUESTS an existing member from a client, which is a different act.
   A count of 9 with an empty diff is a PASS: the owner minted it upstream.
   A count of 10, or any diff hunk inside the array, is a FAIL even if the string is the one
   the ruling names.

8. [GUARD · base: GREEN, exit 1] THE ITEM THAT MATTERS, and it is a conditional.
   grep -n "employer_sharing" apps/worker-app/lib/features/consent/presentation/cubit/consent_cubit.dart
   Base: exit 1, no hits — the app requests `profiling`, `resume_generation`,
   `voice_processing` and nothing else (`:52-56`).
     - Exit 1 today is the CORRECT result and is a PASS: items 6 and 7 of the build brief are
       HALTed on the notice copy.
     - A HIT is a FAIL **unless both of these are also true**, and you must check both:
         (i)  `grep -n "CURRENT_CONSENT_VERSION" packages/types/src/index.ts` shows a value
              other than "2026-08-28" (base value, at `:96`); and
         (ii) apps/worker-app/lib/features/consent/presentation/consent_screen.dart contains
              notice text describing employer sharing.
   PRESCRIBED FAIL SHAPE: the sentence must name WHICH of the two is missing, and must say
   that consent rows are append-only so the recorded consents cannot be corrected later. A
   fail sentence that says only "employer_sharing was added" invites someone to add the copy
   afterwards and leave the already-written rows standing — which is the actual harm.

9. NOT EXECUTABLE TODAY, and record it as such rather than skipping it silently. The
   end-to-end proof — a seeded worker turns a skill off, and a posting that reached him
   through that skill no longer does — needs a schema Prakash has applied and seeded local
   rows. If either is absent, write "NOT EXECUTABLE: <which one>" and do not record a PASS.
   Do not substitute a unit test for it; item 4's mutation is the unit-level evidence and
   this is the integration-level evidence, and they answer different questions.

RECORD IN THE VERDICT, do not check: whether the DPDP notice copy exists is an owner/legal
fact, not a repository fact. State its absence; do not treat it as a code defect.
