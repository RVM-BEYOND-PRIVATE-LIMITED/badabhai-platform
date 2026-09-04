STATUS: BLOCKED ON AN OWNER DECISION — where the draft is stored. Half A does not start
until that is answered. HALF B (GET /schema) is deleted from this phase; see the bottom.

PHASE P8 — job posting drafts and checkpoints. PLAN MODE. Changes the database.

Show me the plan first.

THE STORE IS THE OWNER'S CALL. Three candidates, none of them yours to pick:
  (a) Claim payer_form_drafts (packages/db/src/schema/payer.ts:775-794). It has no consumer
      in apps/ or packages/. ADR-0035:322-325: an unclaimed table "should be reconsidered
      rather than left as speculative surface"; payer.ts:770-771 adds the "(via an ADR)".
      It needs version + a checkpoint child, and the UNIQUE at :792 (one draft per payer per
      form) relaxed — which presupposes a payer may hold two live drafts. ASK, do not assume.
  (b) Extend payer_job_posting_chat_sessions.draft (payer.ts:710) with a version column and
      a checkpoint child. That table already carries five shipped routes; say what moves.
  (c) New tables plus an ADR-0035 amendment.
HALT until you have the answer. Do not choose one because it looks sensible.

WHAT MAIN ALREADY HAS — do not rebuild it, do not re-argue it:
  - The draft is already in Postgres: jsonb on the chat session (payer.ts:710, migration
    0050_tired_rogue.sql:64). The STORE is Postgres. The idempotency reservation below is
    Redis and stays Redis; those are different things.
  - job_postings.status already DEFAULTS to 'draft' (job.ts:89) and the CHECK permits it
    (job.ts:259-260). A half-filled draft still cannot live there: org_label, role_title and
    vacancy_band are NOT NULL (job.ts:75, 76, 88).
  - The payload is a frozen cross-language contract — JobPostingDraftSchema
    (packages/ai-contracts/src/job-posting.ts:83-109), re-parsed on read at
    job-posting-chat.service.ts:617-627. Extend it. Never write a second payload shape.
  - Nothing client-supplied has ever reached that payload: the turn DTO takes session_id and
    text only (job-posting-chat.dto.ts:39-45), and the write takes aiResult.draft
    (service.ts:327). Keep it that way — that is the INVARIANT.
  - Last-write-wins is the gap this phase closes: job-posting-chat.repository.ts:120-125
    names optimistic concurrency as the unbuilt follow-up.

HALF A — the store.

  Wherever it lands it carries version, current_step_id, completed_step_ids, payload jsonb,
  schema_version, source_posting_id, status, last_client, expires_at, plus a checkpoint child
  (draft_id, seq, step_id, payload_delta jsonb, client, member_id, idempotency_key,
  created_at) with UNIQUE (draft_id, idempotency_key). member_id references payer_members.id
  (payer.ts:129). expires_at has no retention value anywhere in this repo — ask for one.

  PIN THE FOLD: last writer wins per top-level key, arrays REPLACED, never concatenated.
  JobPostingDraftSchema has three array fields (skills :85, benefits :94, requirements :95);
  without this rule two honest folds disagree and no checker can judge a difference.

  PRECEDENCE — Idempotency-Key FIRST, expected_version SECOND. Use
  apps/api/src/common/idempotency/request-idempotency.service.ts (runOnce :134, reservation
  :175, replay :234-277). Do not write a second one. It puts two constraints on you:
    - A version conflict must be RETURNED from the work function as a value, never thrown.
      A thrown error is stored as status + message only (:20-22, :277), so a replayed 409
      would lose the payload, the version and the step_id. The controller maps the returned
      conflict envelope to a 409 carrying the current payload, the current version and the
      conflicting step_id. An empty 409 body leaves the client unable to recover.
    - The reservation lives 180s (WINDOW_SECONDS :126) and fails OPEN on a Redis error
      (:163-173). Past the window the DB UNIQUE is the backstop: catch that unique violation
      and answer with the stored checkpoint's outcome. Never a 500, never a second row.

  APPEND-ONLY, enforced by a TRIGGER that RAISEs on UPDATE and on DELETE. A REVOKE is not
  enough — the app's own connection is superuser/BYPASSRLS (rls-spine.e2e.test.ts:210).
  Trigger idiom: 0086_bound_deletion_forensics.sql:149-160 (DROP TRIGGER IF EXISTS, then
  CREATE TRIGGER, --> statement-breakpoint between statements). No migration in this repo
  raises an exception yet; yours is the first.

  Register every new table in tests/e2e/rls-spine.e2e.test.ts LOCKED_TABLES (:39) and call
  .enableRLS(). The drift assertion at :201 goes red otherwise.

  Extend payer-portal.module.boot.test.ts YOURSELF: toContain(<your controller>) at :76-83
  and getMeta("__guards__", …) toContain(PayerAuthGuard) at :104-114. That file is a
  hardcoded list, and canary-coverage.test.ts only walks InternalServiceGuard routes
  (:117) — so an unregistered or unguarded payer controller is invisible to every test in
  this repo until you add those two lines.

  Keep the fold test out of the DB gates — a pure fold function belongs in the normal suite.
  If it must hit the DB, add its filename to .github/workflows/ci.yml:1416 AND bump the
  expected count at :1449 from 9, or it never runs in CI.

  Migration FILE only, with its _journal.json entry. Prakash applies it between this session
  and the check. Main's highest is 0098 and PR #1387 carries 0099 — do not write 0099.

HALF B — GET /payer/job-posting-drafts/schema: DELETED FROM THIS PHASE. Its option sets read
from matching_catalog, which is PR #1387 and is not on main; two of them (shifts, benefits)
are not in that catalog's payload at all (P1_BUILD:17-26); function and collar tiers are P3's
unbuilt columns; the role count is R4-d, unsigned, and BUILD_RULES:31 makes settling it a
full stop. Build no part of it.

INVARIANT: draft.payload is recomputed server-side as the fold of that draft's checkpoint
rows in seq order, and is never taken from a request body.
