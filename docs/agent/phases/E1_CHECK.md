PHASE-ID: E1
STATUS: one question on `E1_BUILD.md`'s STATUS line is UNSIGNED — whether `job_postings`
gains a `trade_key`. The brief is written for "no". If a build shipped a `trade_key` column
anyway, that is a builder settling an open question and it is a FAIL under
`docs/agent/BUILD_RULES.md:31`, not a bonus — see item 7.

INVARIANT: every field the posting form collects reaches `job_postings` in the same
submission — nothing is validated and then dropped.

R-E4 APPLIES TO THIS WHOLE FILE, AND IT IS NOT A FOOTNOTE. The workers on the live database
are testers (owner ruling, 2026-09-05). **Every reach number this phase can produce is a
count over SEEDED LOCAL DATA against a schema Prakash has applied.** A reach preview that
returns 0 here is evidence about the seed, not about the labour market, and must not be
written up as either. An item needing rows nobody has seeded is recorded NOT EXECUTABLE.

EXPECTED ARTIFACTS: a widened `PayerCreateJobPostingSchema`, a one-call create-and-publish
on `createForPayer`, a migration FILE at `packages/db/migrations/0100_*.sql` (written, NOT
applied), a `domain_id` on `MatchSkillDto`, an updated `posting-seam.test.ts`.

HOW TO READ THE LABELS.
  [GUARD]       — must be GREEN at the phase base. Each was run against `f72a7a79` while
                  this brief was written and its base result is recorded below. A GUARD that
                  is red at base cannot distinguish this build from the world; report it as a
                  broken check, never as a FAIL.
  [DELIVERABLE] — must be RED at the phase base. Green at base means there was nothing to
                  build, and that is the finding.

CONVENTION: grep exits 1 on zero matches. Do not run under `set -e`. Paste raw output AND
the exit code for every item.

1. [DELIVERABLE · base: RED — 1 hit] The admission is gone AND the body changed.
   grep -c "stay collected-for-parity but unsent here" apps/payer-web/src/lib/payer-api.ts
   Expect 0.
   THIS ITEM IS NOT SUFFICIENT ON ITS OWN and you must not stop here: deleting a comment
   satisfies it. Item 2 is the real one. Run both, and if 1 passes while 2 fails, the fail
   sentence must say **the comment was removed and the behaviour was not** — a checker who
   writes only "comment gone" has certified a cosmetic edit.

2. [DELIVERABLE · base: RED — 6 keys] The create body carries the payer's answers.
   awk '/^const ALLOWED_KEYS = new Set\(\[/,/^\]\);/' apps/payer-web/src/lib/posting-seam.test.ts | grep -c '^  "'
   Base: 6. Expect the widened set, and read `toPayerJobPostingBody`
   (apps/payer-web/src/lib/payer-api.ts:1036-1046) to confirm the mapper actually emits pay,
   city, shift, needed_by and the experience window.
   FAIL if the mapper is unchanged. PRESCRIBED FAIL SHAPE: name WHICH fields are still
   dropped and quote the mapper's returned keys. "Fields still dropped" alone does not tell
   the next reader whether one field or five are missing, and the difference decides whether
   the phase is nearly done or not started.

3. [DELIVERABLE · base: RED — 7 fields] The create schema widened.
   awk '/^export const PayerCreateJobPostingSchema = z/,/^  \}\)/' apps/api/src/job-postings/job-postings.dto.ts | grep -c ':'
   Base: 7 field lines. Expect more. Then read the schema and confirm the new fields REUSE
   the definitions `UpdateJobPostingSchema` already declares rather than re-declaring them.
   FAIL on a re-declaration: two schemas that disagree about `pay_max >= pay_min` accept
   different bodies on two routes that write one column.

4. [GUARD · base: GREEN — 13 tests, 0 skips] The contract mirror was UPDATED, not deleted.
   grep -c "^  it(" apps/payer-web/src/lib/posting-seam.test.ts
   Base: 13. The count must not FALL.
   grep -n "does NOT leak the not-yet-accepted demand fields" apps/payer-web/src/lib/posting-seam.test.ts
   Base: one hit at :93. After the build this test must be REWRITTEN into its inverse (the
   create body must now CARRY pay and experience), not removed.
   FAIL if the file lost tests, or if any test gained `.skip`:
   grep -n "it.skip\|describe.skip\|it.todo" apps/payer-web/src/lib/posting-seam.test.ts
   — expected exit 1. This is `docs/agent/BUILD_RULES.md:25`, and it is the single most
   likely way this phase goes wrong, because the test's premise is false ON PURPOSE after
   item 3 and deleting it makes the suite green in one keystroke.

5. [GUARD · base: GREEN — zero hits] Money still does not gate `open`.
   grep -ni 'plan\|payment\|razorpay\|quota\|credit' apps/api/src/job-postings/job-postings.service.ts
   Base: zero hits across the whole file. Expect zero.
   FAIL on any hit. Widening the create schema is exactly where a paywall gets built by
   accident: no plan, payment, credit or quota is a precondition of ANY transition into
   `status='open'` today, and `docs/agent/BUILD_RULES.md:27` bars a money-influenced
   ranking input independently.
   PRESCRIBED FAIL SHAPE: say that a TRUST-and-publish path acquired a MONEY precondition,
   and quote the line. A fail sentence naming only the grep hit reads as a lint nit; this is
   a product behaviour change.

6. [GUARD · base: GREEN — exactly one publish route] No second publish, no second writer.
   grep -rn "job_posting.submitted\|job_posting.published" packages/event-schema/src
   Expected exit 1 — the registry refuses a publish event by name and says why
   (packages/event-schema/src/registry.ts:349-350). Control: grep -n
   "job_posting.verification_updated" packages/event-schema/src/registry.ts must return a hit,
   so a zero-result above is a real absence and not a broken pathspec.
   grep -n "sessions/:id/publish" apps/api/src/payer-portal/job-posting-chat/job-posting-chat.controller.ts
   Expect a hit at :134. FAIL on exit 1 — that route is in ADR-0035's endpoint table with two
   shipped clients, and removing it needs a superseding ADR first.

7. [GUARD · base: GREEN — 4 hits, none in `job_postings`] `job_postings` gained no `trade_key`.
   grep -n "tradeKey\|trade_key" packages/db/src/schema/job.ts
   Base: four hits, ALL inside the `jobs` table — the column at :397 and three mentions at
   :423, :453, :454. Expect the same four and no new one
   inside `jobPostings`, which opens at `:62` and ends before `:391`.
   READ THE LINE NUMBERS, do not just count: a bare count passes if a `trade_key` was added
   to `job_postings` and one was removed from `jobs`. FAIL if any hit falls between :62 and
   :390 — that is an unsigned question settled by building.

8. [GUARD] The migration was WRITTEN and NOT APPLIED, and does not collide.
   ls packages/db/migrations/0099* packages/db/migrations/0100*
   Base: `0099_overrated_fantastic_four.sql` does NOT exist on main. It lives on
   `origin/p1-matching-catalog` (a454fac0), whose PR **#1387 is CLOSED and unmerged**
   (closed 2026-09-04) — so 0099 is free on paper and burned in practice. Expect exactly one
   new `0100_*.sql` here.
   FAIL if the new file is numbered 0099. It will not conflict today; it conflicts the day
   that branch is revived, and then whichever migration is applied second is silently skipped
   with no error.
   git diff $(git merge-base origin/main HEAD)..HEAD -- packages/db/migrations/meta/_journal.json
   The new entry's `when` must be the largest in the file. A hand-set timestamp below the
   current maximum makes drizzle skip it AND every migration after it, with no error.
   THIS ITEM CANNOT CONFIRM THE MIGRATION WAS NOT RUN — the repository does not record that.
   Say so; do not claim it.

9. [DELIVERABLE] One call, and it reuses the publish path.
   Read `createForPayer` (apps/api/src/job-postings/job-postings.service.ts:350-371).
   FAIL if the phase added a second implementation of the `draft → open` transition, of the
   reach materialization, or of the E13 zero-reach refusal. All three live in
   `materializeIfNeeded` (`:497-526`) and there must still be exactly one of each.
   grep -c "materializeIfNeeded" apps/api/src/job-postings/job-postings.service.ts
   Base: 3 (the declaration plus two call sites). Expect 4 — one new call site, not a new
   method. A count of 5+ with a second private method is the FAIL.

10. [GUARD · base: GREEN — 15 and 18] The two role vocabularies did not merge or drift.
    awk '/^export const TRADE_KEYS = \[/,/^\] as const;/' apps/payer-web/src/lib/contracts.ts | grep -c '^  "'
    Base: 15. Expect 15 — the constant must SURVIVE, because the agency job form still uses
    it (`toAgencyJobBody`, apps/payer-web/src/lib/payer-api.ts:596-608) and that is a
    different entity on a different table.
    grep -c '^    skillId: "mskill_' packages/taxonomy/src/match-skills.ts
    Base: 18. Expect 18 — widening the match vocabulary is out of this phase's scope.
    grep -n "TRADE_KEYS" apps/payer-web/src/app/\(portal\)/postings/new/posting-form.tsx
    Base: three hits — the import at :6, the blank-form default at :63 and the `<select>`
    options at :260. Expect exit 1 after the build: the posting form must read the served
    vocabulary instead. A build that leaves :6 and removes only :260 has left a dead import
    and a live default from the wrong list — read all three, do not count.

11. NOT EXECUTABLE UNTIL PRAKASH APPLIES 0100. The end-to-end proof — post a job once with
    pay, city, shift and an experience window, and read the row back with all of them set —
    needs the applied migration. If the columns are absent, write "NOT EXECUTABLE: migration
    0100 unapplied" and do NOT record a PASS. Do not substitute a unit test: items 2 and 3
    prove the wire shape, and this proves the column, and they answer different questions.

RECORD IN THE VERDICT, do not check: `job_domain_id` is still hardcoded to the transitional
`"cnc-machining"` anchor (apps/api/src/job-postings/job-postings.service.ts:46). It is real,
it is out of this phase's scope, and a checker who "fixes" it has left the brief.
