PHASE-ID: P8
INVARIANT: replaying all checkpoints always produces exactly draft.payload.

EXPECTED ARTIFACTS: migration files for job_posting_drafts and
job_posting_draft_checkpoints, a checkpoint POST endpoint with version checking,
and GET /payer/job-posting-drafts/schema.
If these do not exist, VERDICT is FAIL, reason "phase not built". Stop there.

Do these checks and paste raw output for each:
1. Confirm the draft lives in Postgres. grep for the draft id being used as a Redis
   key. Any Redis key holding draft content is a FAIL.
2. Build a draft through 6 checkpoints. Replay the checkpoint chain yourself in seq
   order and compare your computed result to the stored draft.payload, byte for byte.
   Any difference is a FAIL. Paste both.
3. CONCURRENCY: read one draft at version N from two clients. Send a checkpoint from
   each, both with expected_version = N. The second must return 409 carrying the
   current payload and the conflicting step_id. A 200 is a FAIL. A 409 with an empty
   body means the client cannot recover — report it as not good enough.
4. IDEMPOTENCY: send the identical checkpoint POST with the same Idempotency-Key five
   times. Exactly one checkpoint row must exist. More than one is a FAIL.
5. APPEND-ONLY: try an UPDATE and a DELETE directly on
   job_posting_draft_checkpoints. Both must be refused. Success is a FAIL.
6. Confirm no draft row was created in job_postings. Any status = draft row from this
   flow is a FAIL.
7. Call GET /schema. Confirm the role options come from matching_catalog, not a
   hardcoded array. grep the handler for a literal role list. Any hit is a FAIL.
8. Confirm affects_matching is present on every field in the response.
