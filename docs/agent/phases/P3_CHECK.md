PHASE-ID: P3
INVARIANT: no existing row gets a value in any of the four new columns that it did not supply;
all four land NULL on every pre-existing row.

R1 IS UNSIGNED (docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md:388) and P3_BUILD orders a HALT
while it is open. VERDICT.md carries PASS or FAIL on line 1 and nothing else (CHECK_RULES:43) —
there is no HALT verdict available to you. If the build produced a HALT report and no migration,
write FAIL with the reason "phase not built" (CHECK_RULES:10-12) and add one line: the builder
correctly halted on R1, quoting worksheet:388. That wording is required, not a softening, and
not a fault found in the builder.

If a migration DOES exist, run all of these and paste raw output.
1. Paste every ADD COLUMN line for the four columns. A DEFAULT on any is a FAIL. An UPDATE or
   backfill filling any is a FAIL. NOT NULL on any is a FAIL.
2. grep -ic "create type" <migration> || true — anything but 0 is a FAIL. Then grep -n pgEnum on
   packages/db/src/schema/match.ts and .../job.ts — any hit is a FAIL (schema/index.ts:7-9).
3. Confirm it is registered: the _journal.json entry exists, NNNN_snapshot.json exists, and the
   entry's `when` exceeds every earlier entry's. A missing entry, a missing snapshot, or a lower
   `when` is a FAIL — drizzle skips the file silently and nothing applies
   (packages/db/src/migration-adoption.test.ts:556-568).
4. Find the migration-text test under packages/db/src/. If none reads the new migration's text,
   that is a FAIL under CHECK_RULES:31 — stop this item there. Otherwise run it, paste the
   output, then prove it can go red: cp the migration to your scratchpad, add DEFAULT 'operator'
   to the function column in the real file, re-run, paste the FAILING output. Restore by cp back,
   then paste `diff` of the two (must be empty) and `git status packages/db/migrations/`. No red
   output is a FAIL; an unproven restore is a FAIL.
5. Only if Prakash has applied it (BUILD_RULES:21-24) — never apply it yourself; if unapplied,
   record that under "What I could not verify". Paste `SELECT COUNT(*) FROM worker_skill;` and
   `SELECT COUNT(*) FROM job_postings;` FIRST. A table at 0 rows proves nothing for that table —
   record it. For each table with rows, paste:
     SELECT COUNT(*) FROM worker_skill WHERE "function" IS NOT NULL OR collar_tier IS NOT NULL;
     SELECT COUNT(*) FROM job_postings WHERE function_required IS NOT NULL OR collar_tier_min IS NOT NULL;
   Any count other than 0 is a FAIL. In `\d worker_skill`, function and collar_tier must each
   show no "not null" and no Default; either present is a FAIL.
6. Paste the rollback path. It must drop exactly the four columns it added and nothing else.
