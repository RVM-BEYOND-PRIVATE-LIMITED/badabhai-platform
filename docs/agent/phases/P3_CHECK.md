PHASE-ID: P3
INVARIANT: zero existing rows get an invented function or collar_tier.

EXPECTED ARTIFACT: a migration file adding function and collar_tier to worker_skills
and function_required / collar_tier_min to job_postings, with a rollback path.
If it does not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Read the migration file. Any DEFAULT on these columns is a FAIL. Any UPDATE
   statement that fills them is a FAIL. Paste the relevant lines.
2. Confirm the migration was written and never executed. Check shell history.
3. On a COPY of live data: record the row count of worker_skills first. Apply the
   migration to the copy. Then run:
     SELECT COUNT(*) FROM worker_skills WHERE function IS NOT NULL;
   It must be 0. Paste both queries and both results.
4. Confirm both columns are NULLABLE. Paste the \d output.
5. Confirm a rollback path exists in the file.
