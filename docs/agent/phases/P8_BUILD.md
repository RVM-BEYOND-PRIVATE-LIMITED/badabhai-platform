PHASE P8 — job posting drafts and checkpoints. PLAN MODE. Changes the database.

Show me the plan first.

THREE THINGS YOU WILL WANT TO DO. ALL THREE ARE A HALT:
  1. Putting the draft in Redis because the chat buffer uses Redis.
     The codebase report already lists Redis buffer loss as a live data-loss path.
     A worker interview can be redone. A half-written job post from a paying
     customer cannot. Use Postgres.
  2. Last-write-wins on two devices editing at once. It destroys work silently.
  3. Storing the draft inside job_postings with status = draft. That puts
     half-valid rows in the table that matching reads from.

Build these tables:

  job_posting_drafts(
    id, payer_id, created_by_member_id, source_posting_id,
    status, current_step_id, completed_step_ids[], payload jsonb,
    schema_version, version, last_client, created_at, updated_at, expires_at)

  job_posting_draft_checkpoints(
    id, draft_id, seq, step_id, payload_delta jsonb,
    client, member_id, idempotency_key, created_at)
    UNIQUE (draft_id, idempotency_key)

Checkpoints are APPEND-ONLY. No UPDATE. No DELETE. Enforce this.
draft.payload is the folded result of all checkpoints and must be replayable from them.

Concurrency: every checkpoint POST carries expected_version.
If it does not match, return 409 with the current payload and the conflicting step_id.
Never return 200.

Add GET /payer/job-posting-drafts/schema?version=N returning:
  step ids and order, field ids and input types,
  chip option sets (22 roles, function enum, collar tiers, shifts, benefits,
  per-role attribute whitelists — all read from matching_catalog),
  validation rules, required-for-publish flags, conditional visibility,
  and affects_matching true/false for every field.

Migration FILE only.

INVARIANT: replaying all checkpoints always produces exactly draft.payload.
