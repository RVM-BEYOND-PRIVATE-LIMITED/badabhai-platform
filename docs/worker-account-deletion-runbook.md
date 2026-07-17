# Runbook — Worker Account Deletion (DPDP erasure, 7-day grace)

> ADR-0026 Phase 5, as amended by [ADR-0031](decisions/0031-account-deletion-grace-window.md).
> Confirm **schedules** a hard-delete; it no longer erases in-request.
> Flow: `POST /auth/account/delete/request` → step-up OTP → `POST /auth/account/delete/confirm`
> → `200 { scheduled_for }` → **7-day grace (cancel anytime)** → hourly sweep → the unchanged
> erasure cascade → `worker.account_deleted`.
> **During grace the undo IS the cancel endpoint** (`POST /auth/account/delete/cancel`).
> **The EXECUTED (post-sweep) erasure has NO undo.** Only the endpoint/migration PRs are revertable.

## 1. Purpose & scope
- DPDP right-to-erasure for a worker who asks to delete their account — timed as disclosed in
  the app copy ("7 din mein delete; is dauraan cancel kar sakte hain").
- **Schedules (reversible):** `workers.deletion_scheduled_at = now() + ACCOUNT_DELETION_GRACE_DAYS`
  (default 7d). NULL = active; set = pending. During grace the row is a **live worker row** —
  login/refresh work unchanged; the app shows a pending banner + "Delete cancel karein".
- **Freezes during grace (payer surfaces, ADR-0031 ruling (b)):** pending-deletion workers are
  excluded from the reach pool, new unlock/disclosure requests are denied with the existing
  byte-identical neutral body (no oracle), and re-engagement sends are suppressed.
- **Destroys (irreversible, post-sweep — UNCHANGED from Phase 5):** the `workers` row (raw
  phone/name ciphertext) + all `ON DELETE CASCADE` PII children — `worker_consents`,
  `worker_devices`, `worker_credentials` (PIN), `worker_profiles`, `chat_sessions`,
  `chat_messages`, `voice_notes`, `generated_resumes`, `worker_answers`, `applications`,
  `resume_downloads`, `worker_flags` — plus Supabase Storage objects (resume PDFs + archived
  conversations). `AccountDeletionService.execute` is byte-for-byte the Phase-5 cascade; only
  its trigger moved (sweep instead of the confirm request).
- **Retains (PII-free, lawful):** the `events` + `audit_logs` spine (opaque ids, no FK to
  `workers`) and the three billing/intent rows whose worker FK is `SET NULL` on delete —
  `unlocks` (paid contact-unlock), `resume_disclosures`, `invites.inviter_worker_id`. These
  carry no PII once the worker join is nulled.

## 2. Preconditions (before this runs in any non-local env)
- [ ] Migration **0031** (3 billing FKs `cascade → SET NULL` + nullable) **signed off (Prakash/Akshit) and
      applied** — else worker deletion would DESTROY paid-unlock / disclosure / referral rows. This is the §7 gate.
- [ ] Migration **0038** (`workers.deletion_scheduled_at` + partial index `workers_deletion_due_idx`) applied —
      the sweep's due-scan and the grace marker both depend on it.
- [ ] Events `worker.deletion_scheduled`, `worker.deletion_cancelled`, `worker.account_deleted` registered +
      deployed (event-first spine).
- [ ] The **sweep** deployed: `ACCOUNT_DELETION_QUEUE` processor registered in `apps/api` (in-process, like the
      other five queues) with `ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS` set (default 1).
- [ ] **Post-deploy, confirm the sweep is actually running:** `GET /health` →
      `checks.deletion_sweep: "up"`. `down` means the scheduler is not registered — erasure will not
      fire (see §6 + [observability-runbook.md §7](observability-runbook.md)).
- [ ] `StorageService.deletePdf` / `deleteByPrefix` deployed.
- [ ] OTP path healthy (Fast2SMS reachable + Redis up) — step-up OTP must work or `/confirm` fails closed
      (bad OTP ⇒ nothing scheduled).

## 3. Normal (worker-driven) flow
1. Worker (authenticated) calls `POST /auth/account/delete/request` → receives an OTP on their phone.
2. Worker calls `POST /auth/account/delete/confirm` with the OTP → `200 { scheduled_for }`.
   Nothing is erased; `deletion_scheduled_at` is set and `worker.deletion_scheduled` emitted.
   **Idempotent:** a second confirm during grace returns the **same** `scheduled_for` — the clock
   never resets without a cancel. Sessions are NOT revoked (the worker keeps the app so they *can* cancel).
3. **Grace (7 days).** The worker may cancel anytime — `POST /auth/account/delete/cancel`
   (authenticated session only; id from the token) or the app's "Delete cancel karein" action.
   Cancel clears the marker + emits `worker.deletion_cancelled`; cancel with nothing pending is a
   `200` no-op (no event). Login during grace works normally and shows an **explicit cancel
   prompt** — a login is **never** treated as an implicit cancel.
4. **Sweep.** The hourly `ACCOUNT_DELETION_QUEUE` job claims rows with `deletion_scheduled_at <= now()`,
   atomically re-checks each is still due (cancel-vs-sweep race guard), then runs the unchanged
   erasure cascade per worker (§6 below).
5. No operator action. Verify scheduling via §5a immediately; verify the executed erasure via §5b
   after the grace window elapses.

## 4. Operator-assisted / DSAR-by-ticket flow
- For a worker who cannot self-serve (lost device, support ticket):
  - Authorization required from **Prakash/Akshit** (named approver recorded in the ticket).
  - Execution against prod is a **human-gated** step — the endpoint still requires the worker's own step-up OTP;
    do not bypass it. Record the approver + ticket id in the ops log.
  - The grace window applies to ticket-driven deletions too — do NOT shortcut the sweep by invoking
    the erasure directly; the disclosed 7-day cancel right holds for every deletion path.
- To list pending deletions (ops, read-only):
  ```sql
  SELECT id, deletion_scheduled_at FROM workers WHERE deletion_scheduled_at IS NOT NULL;
  ```

## 5a. Verification checklist (scheduling — run right after a confirm)
- [ ] `workers.deletion_scheduled_at` set (`SELECT deletion_scheduled_at FROM workers WHERE id = :id` → non-NULL,
      ≈ now() + `ACCOUNT_DELETION_GRACE_DAYS`).
- [ ] `worker.deletion_scheduled` event present with a `scheduled_for` matching the column (opaque
      `worker_id` + timestamp only — no PII).
- [ ] The worker can still log in / refresh (grace keeps the row live) and the app shows the pending banner.
- [ ] Payer freeze active — the worker is absent from the reach pool; a new unlock/disclosure attempt
      returns the neutral-unavailable body; re-engagement sends are suppressed.
- [ ] (If cancelled) marker back to NULL + `worker.deletion_cancelled` event present; freeze lifted.

## 5b. Verification checklist (executed erasure — after the sweep runs)
- [ ] `workers` row gone (`SELECT … WHERE id = :id` → 0 rows).
- [ ] Cascade children gone — spot-check `worker_profiles`, `chat_messages`, `generated_resumes`, `worker_credentials`.
- [ ] Storage empty — `conversationWorkerPrefix(:id)` lists 0 objects; the captured resume keys 404.
- [ ] Billing rows SURVIVE with the worker FK NULL — `unlocks.worker_id`, `resume_disclosures.worker_id`,
      `invites.inviter_worker_id`.
- [ ] `worker.account_deleted` event present with `storage_objects_failed = 0` (see §7 if > 0).
- [ ] Redis cool-down key `deleted_phone:<phone_hash>` set — note: currently **write-only** (no auth-path
      reader), so it does not yet block re-registration (TD64 in the tech-debt register).
- [ ] No session can re-auth the deleted worker (revoke runs first inside the cascade).

## 6. The sweep (how erasure actually fires)
- **Queue:** `ACCOUNT_DELETION_QUEUE` (BullMQ, in-process processor in `apps/api` — same idiom as the
  other five queues). A repeatable/self-rescheduling job runs every `ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS`
  (default 1).
- **The DB marker is authoritative, not Redis.** Each run selects due ids via the partial index
  `workers_deletion_due_idx`, then per worker **atomically re-checks** the row is still due before
  calling `AccountDeletionService.execute(workerId)` — a cancel that lands mid-sweep wins. A lost
  Redis **job** is harmless: the next sweep re-reads the marker and catches anything missed.
- **A lost SCHEDULER is NOT harmless — check `/health`.** The "next sweep catches it" guarantee
  assumes a next sweep exists. If the boot **registration** of the repeatable job fails (Redis ACL,
  bullmq mismatch) or the scheduler is removed out-of-band (Redis flush/eviction), nothing ticks and
  overdue rows sit unerased while every request path looks fine. Registration therefore retries on a
  bounded backoff (~80s), and `GET /health` reports `checks.deletion_sweep: "up"|"down"` (a live
  lookup of the scheduler in Redis). **`down` ⇒ erasure has stopped** → triage per
  [observability-runbook.md §7](observability-runbook.md) (SEV2 if it persists past a restart).
  Nothing is lost — the marker survives and a re-registered sweep drains the backlog in schedule
  order — but the delay must be seen, not silent.
- **Best-effort per worker:** a failure on one worker logs (opaque id prefix only) and continues;
  `execute` is idempotent and no-ops on already-gone workers, so re-runs are always safe.
- Accepted residual: a cancel landing in the milliseconds between the re-check and the cascade's
  session-revoke can still be erased — documented + accepted in ADR-0031 (a 7-day window ends somewhere).

## 7. Partial-failure recovery
- The erasure orchestration is **idempotent / re-runnable** — re-invoking on a gone worker is a no-op,
  and the next sweep retries any worker whose marker survived a failed run.
- If the event shows `storage_objects_failed > 0`: an object/prefix delete failed (orphan keyed by an opaque
  UUID, non-PII-linkable). Re-run a storage sweep for the worker's conversation prefix + captured resume keys.
- The DB erasure is atomic (single transactional `DELETE` + cascade) — it either removed identity or did not;
  a storage hiccup never leaves the worker half-deleted in the DB. Revoke-sessions runs first, so a partially
  failed run never leaves a re-authable deleted worker.

## 8. Rollback & undo semantics
- **During grace, the undo is the product:** `POST /auth/account/delete/cancel` (or the app banner) clears the
  marker and re-opens every frozen surface. No operator SQL needed; never clear `deletion_scheduled_at` by hand
  except under a Prakash/Akshit-approved ticket (and then note that no `worker.deletion_cancelled` event fires —
  prefer having the worker cancel in-app so the spine stays truthful).
- **The executed (post-sweep) cascade has NO undo** — there is no "restore worker" path. Raw phone/name
  ciphertext is gone. This is unchanged from Phase 5.
- Only the **endpoint PRs** and the **migrations** are revertable: 0038's rollback (drop column + index) merely
  reverts pending deletions to active; reverting 0031 requires that no billing row currently holds a NULL worker
  FK — see the migration's inline `-- ROLLBACK:` note.
- This irreversibility is WHY the gate on the executed erasure is strong: step-up OTP to schedule + a 7-day
  worker-cancellable window + **human-gated (§7) prod runs** for any operator-driven execution.

## 9. Audit trail (what survives, and why it is lawful)
- The PII-free `events` (`worker.deletion_scheduled` / `worker.deletion_cancelled` /
  `worker.account_deleted` + the worker's prior opaque events) and `audit_logs` survive —
  opaque ids only, no raw PII. DPDP permits retaining a non-identifying record of processing.
- A cancelled deletion leaves the scheduled/cancelled event pair as the durable record that the
  worker exercised — then withdrew — the erasure request.
- The `SET NULL`'d billing/intent rows record THAT a paid unlock / disclosure / referral occurred, with no
  worker identity attached — a legitimate financial-record interest, PII-free.
