STATUS: REOPENED 2026-09-05 — owner ruling. NOT closed with P0-P12, and NOT part of the
E-chain. This phase runs STANDALONE.

THE CHOICE, AND WHY, because the owner gave two ways to remove the dangling pointer and this
brief took the first. ADR-0035 Amendment 1 (Accepted, owner ruling 2026-09-04) names THIS
FILE BY PATH as the workstream claiming `payer_form_drafts`
(docs/decisions/0035-ai-job-posting-chat-and-cross-device-drafts.md:339, :348). The options
were: keep P8 open as the amendment's home, or write the amendment's retirement into the ADR.

KEEP P8 OPEN. Three reasons, in increasing order of force:

  1. RETIRING THE AMENDMENT DOES NOT REHOME THE OTHER TWO SURVIVORS. P8 carries three things
     no E-phase covers and only one of them is the table claim; the optimistic-concurrency
     gap and the checkpoint table would still need a home.
  2. IT WOULD TRADE A DANGLING POINTER FOR A DANGLING TABLE. `payer_form_drafts` is real,
     shipped, and unclaimed (packages/db/src/schema/payer.ts:775-795). ADR-0035's own
     §Consequences asks that an unclaimed table "should be reconsidered rather than left as
     speculative surface" — retiring the claim without disposing of the table restores
     precisely the state the amendment was written to end.
  3. THE BRIEF IS NOT STALE. It was rewritten against ADR-0036 and shipped code in #1416: the
     store question is RULED and Half A is buildable. Reopening it is not reviving a wrong
     document.

Retiring the amendment stays available if the owner prefers it — but it is then an ADR
supersede AND a disposition of the table, not a one-line edit.

The rest of this file stands as written.

------------------------------------------------------------------------------
STATUS: HALF A IS BUILDABLE. The store is ruled — claim payer_form_drafts (owner ruling
2026-09-04). HALF B (GET /schema) stays deleted from this phase; see the bottom.
PHASE-ORDER GATE: docs/agent/README.md:47 requires the previous VERDICT to be PASS, and
docs/qa/evidence/ holds only P0 (FAIL) and PX. Ask the owner to lift it before you start.

PHASE P8 — job posting drafts and checkpoints. PLAN MODE. Changes the database.

Show me the plan first.

THE STORE — RULED, do not re-open it. Claim payer_form_drafts
(packages/db/src/schema/payer.ts:775-794). It was shipped by ADR-0035 as forward
scaffolding naming `job_posting` as its own example, and it has no consumer in apps/ or
packages/. ADR-0035:322-325 says an unclaimed table "should be reconsidered rather than left
as speculative surface"; payer.ts:770-771 adds the "(via an ADR)". Building a third store
beside it is the duplication P2 exists to remove.

  Two changes the claim requires, both ruled:
  - ADD a `version` column. The table has none, so it is last-write-wins today — the exact
    thing this phase closes.
  - RELAX the UNIQUE at :792 off (payer_id, form_type). One row per payer per form cannot
    hold a new-posting draft and a reopened edit at once, and this phase needs both.
    Widen it to include the draft id, or drop it for a partial index on the live status —
    say which you chose and why.

  AMEND ADR-0035 IN THIS PHASE, not afterwards. It is the ADR that shipped the table
  unclaimed and asked for exactly this. The amendment records: P8 is the workstream that
  claims it, the two schema changes above, and that the table's "no consumer" note at
  ADR-0035:111 and :323 no longer holds. A migration that claims a table an ADR describes
  as unclaimed, without amending the ADR, leaves two records disagreeing.

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

  payer_form_drafts gains version, current_step_id, completed_step_ids, payload jsonb,
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
are not in that catalog's payload at all (P1_BUILD:17-26); and function and collar tiers are P3's
unbuilt columns. Build no part of it. (The role count is no longer a blocker — R4-d(b) is
ruled: 21. The registry declares five with formEnabled true, so a chip set is still read
from the registry, never from a hand-typed list of any length.)

INVARIANT: draft.payload is recomputed server-side as the fold of that draft's checkpoint
rows in seq order, and is never taken from a request body.
