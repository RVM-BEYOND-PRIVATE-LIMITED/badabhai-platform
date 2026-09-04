STATUS: CLOSED 2026-09-05 — superseded by the E-chain (docs/decisions/E_CHAIN_DESIGN_2026-09.md).
Do not build from this file without reopening the phase.

WHAT NO E-PHASE COVERS — dropped visibly, not quietly. Each survived an adversarial
refutation pass (already-ships / an-E-phase-covers-it / a-signed-ruling-deleted-it):
  - The disposition of `payer_form_drafts` — built as forward scaffolding for exactly this,
    claimed by nothing. Closing P8 leaves a signed ADR-0035 amendment pointing at a dead
    brief.
  - Optimistic concurrency for the AI job-posting chat draft. Neither candidate table has a
    version column and `saveTurn`'s UPDATE has no version predicate — last-write-wins,
    which the code itself names as an unbuilt follow-up.
  - The checkpoint child table, its append-only trigger, the server-side fold, and the
    Idempotency-Key-then-`expected_version` 409 envelope.

------------------------------------------------------------------------------
PHASE-ID: P8
INVARIANT: draft.payload is recomputed server-side as the fold of that draft's checkpoint
rows in seq order, and is never taken from a request body.

THE STORE IS RULED: payer_form_drafts (owner ruling 2026-09-04). A build that created a NEW
draft table instead is a FAIL — the ruling exists because a third store beside an unused one
is the duplication P2 exists to remove. A build that extended
payer_job_posting_chat_sessions.draft instead is also a FAIL.

EXPECTED ARTIFACTS: a migration FILE altering payer_form_drafts (adding version and the
fields at P8_BUILD's "HALF A"), a migration FILE for its append-only checkpoint child, a
checkpoint POST endpoint, and an ADR-0035 amendment recording the claim.
GET /payer/job-posting-drafts/schema is NOT expected — if it exists, that is a FAIL. Half B
was deleted from the phase.

0. THE CLAIM. Confirm the UNIQUE at packages/db/src/schema/payer.ts:792 no longer forbids two
   live drafts for one payer: create a new-posting draft AND a reopened edit for the SAME
   payer, and assert both rows exist. One row, or a unique violation, is a FAIL — a reopened
   edit would silently overwrite an in-progress posting. Then confirm ADR-0035 carries the
   amendment; an unamended ADR still saying the table has no consumer is a FAIL.

Prakash applies the migration before you run. Read the checkpoint table's real name out of
the migration file and paste it; every SQL item below uses that name. Paste raw output.

1. MIGRATION: the file is under packages/db/migrations/, is not numbered 0099 (PR #1387
   holds it), and has a _journal.json entry whose `when` exceeds every existing entry.
   Then \d+ the checkpoint table. A collision, a missing journal entry, or a missing table
   is a FAIL — an unjournalled migration is silently skipped.
2. FOLD: build one draft through 6 checkpoints whose deltas OVERLAP on at least two keys and
   on one array field (disjoint deltas make every fold rule agree and prove nothing). Re-fold
   in seq order with a merge you write here — do NOT import the service's fold, or you are
   diffing a value against itself. Any difference is a FAIL. Paste both.
3. NO BODY-SUPPLIED PAYLOAD: POST a checkpoint carrying BOTH a payload_delta and a full
   `payload` that disagrees with it. The stored payload must follow the fold. Following the
   body is a FAIL. Then grep every write site of the payload column across apps/api/src and
   packages; more than one writer is a FAIL. Paste the grep.
4. MUTATION: find the test that asserts the fold. If none exists, FAIL — CHECK_RULES requires
   the invariant be protected by a test that can fail. Change one payload_delta in its
   fixture, run it, paste the RED, revert, confirm `git status` is clean. Still passing is a FAIL.
5. IDEMPOTENCY: PING Redis first and paste it — the seam fails OPEN without it
   (request-idempotency.service.ts:163-173) and this item is then meaningless. POST the same
   checkpoint 5x under one Idempotency-Key, all five within 180s (WINDOW_SECONDS :126).
   Exactly one checkpoint row, five byte-identical bodies. More rows, or a bare 409 on
   attempts 2-5, is a FAIL — the key is reserved before the version is read (:175).
6. CONCURRENCY: two clients read version N, both POST expected_version = N, each with a
   DISTINCT Idempotency-Key (a shared key replays the first outcome and tests nothing). The
   second must be 409 with the current payload, the current version and the conflicting
   step_id. A 200 is a FAIL. An empty body is a FAIL.
7. APPEND-ONLY: UPDATE and DELETE directly on the checkpoint table. Both must be refused by a
   TRIGGER that raises — paste the CREATE TRIGGER and its function from the migration. A
   REVOKE-only implementation is a FAIL: this connection is superuser/BYPASSRLS
   (rls-spine.e2e.test.ts:210) and walks through it.
8. RLS SPINE: RUN_E2E=1 E2E_DATABASE_URL=<the applied DB> pnpm --filter @badabhai/e2e test
   rls-spine. The line "LOCKED_TABLES matches the live public schema and the model (no
   drift)" (:201) must print as PASSED. SKIPPED is a FAIL — without RUN_E2E=1 the suite
   skips and vitest exits 0 (:31, :176). The anon/authenticated/service_role roles must
   exist on that DB or it reds for a pre-existing reason.
9. REGISTRATION: run apps/api/src/payer-portal/payer-portal.module.boot.test.ts. Then delete
   the new controller's line from the module's `controllers` array, re-run, paste the RED,
   revert. Green after that deletion means the controller was never asserted — a FAIL.
